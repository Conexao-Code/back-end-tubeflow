const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const MP_API_URL = process.env.NODE_ENV === 'production' 
    ? 'https://api.mercadopago.com' 
    : 'https://api.mercadopago.com/sandbox';

const getCredentials = async (connection) => {
    const [keys] = await connection.query(
        `SELECT access_token, public_key, encrypted_private_key 
         FROM api_keys 
         WHERE environment = ? 
         LIMIT 1`,
        [process.env.NODE_ENV || 'sandbox']
    );
    
    // Decriptografar chave privada
    const decipher = crypto.createDecipheriv('aes-256-cbc', 
        process.env.ENCRYPTION_KEY, 
        Buffer.from(keys[0].encrypted_private_key.iv, 'hex')
    );
    let decryptedKey = decipher.update(keys[0].encrypted_private_key.data, 'hex', 'utf8');
    decryptedKey += decipher.final('utf8');
    
    return {
        accessToken: keys[0].access_token,
        publicKey: keys[0].public_key,
        privateKey: decryptedKey
    };
};

router.post('/create-pix-payment', rateLimit, async (req, res) => {
    const connection = await req.db.getConnection();
    try {
        const { amount, user } = req.body;
        
        // Validação
        if (!amount || amount < 1 || !user || !user.cpf || !user.name) {
            return res.status(400).json({ error: 'Dados inválidos' });
        }

        // Obter credenciais seguras
        const credentials = await getCredentials(connection);
        
        // Gerar payload para Mercado Pago
        const paymentData = {
            transaction_amount: Number(amount),
            payment_method_id: 'pix',
            payer: {
                email: user.email,
                first_name: user.name.split(' ')[0],
                last_name: user.name.split(' ').slice(1).join(' '),
                identification: {
                    type: 'CPF',
                    number: user.cpf.replace(/\D/g, '')
                }
            },
            notification_url: `${process.env.API_BASE_URL}/payment/webhook`,
            additional_info: {
                items: [{
                    id: 'subscription',
                    title: 'Assinatura Premium',
                    quantity: 1,
                    unit_price: Number(amount)
                }]
            }
        };

        // Criar pagamento no Mercado Pago
        const response = await axios.post(`${MP_API_URL}/v1/payments`, paymentData, {
            headers: {
                'Authorization': `Bearer ${credentials.accessToken}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': uuidv4() // Prevenção de requisições duplicadas
            }
        });

        // Registrar pagamento no banco
        await connection.query(
            `INSERT INTO payments 
             (mp_payment_id, user_id, amount, pix_code, pix_qr_code, expiration_date, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                response.data.id,
                user.id,
                amount,
                response.data.point_of_interaction.transaction_data.qr_code,
                response.data.point_of_interaction.transaction_data.qr_code_base64,
                new Date(response.data.date_of_expiration),
                'pending'
            ]
        );

        res.json({
            paymentId: response.data.id,
            qrCode: response.data.point_of_interaction.transaction_data.qr_code,
            qrCodeBase64: response.data.point_of_interaction.transaction_data.qr_code_base64,
            expiration: response.data.date_of_expiration
        });

    } catch (error) {
        console.error('Erro na criação do PIX:', error.response?.data || error.message);
        
        // Log de erros detalhado
        await connection.query(
            `INSERT INTO payment_errors 
             (user_id, error_code, error_message, request_data)
             VALUES (?, ?, ?, ?)`,
            [user?.id, error.response?.status, error.message, JSON.stringify(req.body)]
        );

        res.status(500).json({ 
            error: 'Erro ao processar pagamento',
            code: error.response?.status 
        });
    } finally {
        connection.release();
    }
});

// Webhook para atualizações de status
router.post('/payment/webhook', async (req, res) => {
    try {
        // Verificar assinatura
        const signature = req.headers['x-signature'];
        const payload = req.body;
        
        const hash = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
                          .update(JSON.stringify(payload))
                          .digest('hex');
                          
        if (hash !== signature) {
            return res.status(401).send('Assinatura inválida');
        }

        const connection = await req.db.getConnection();
        
        // Atualizar status do pagamento
        await connection.query(
            `UPDATE payments 
             SET status = ?, updated_at = NOW()
             WHERE mp_payment_id = ?`,
            [payload.action === 'payment.updated' ? payload.data.status : 'cancelled', 
             payload.data.id]
        );

        // Lógica adicional para status aprovado
        if (payload.data.status === 'approved') {
            await connection.query(
                `UPDATE users 
                 SET premium_status = 'active', 
                     premium_expiration = DATE_ADD(NOW(), INTERVAL 1 MONTH)
                 WHERE id = (
                     SELECT user_id FROM payments 
                     WHERE mp_payment_id = ?
                 )`,
                [payload.data.id]
            );
        }

        connection.release();
        res.sendStatus(200);
        
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(500).send('Erro interno');
    }
});