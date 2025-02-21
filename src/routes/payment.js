const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

// Configurações
const MP_API_URL = process.env.MP_API_URL || 'https://api.mercadopago.com/v1';
const PIX_EXPIRATION = 15 * 60 * 1000; // 15 minutos

// Rate Limiter Específico para Pagamentos
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Muitas tentativas de pagamento. Tente novamente mais tarde.',
  keyGenerator: (req) => req.ip + '-' + (req.body.user?.cpf || '')
});

// Validação de CPF
const validateCPF = (cpf) => {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11 || !!cpf.match(/(\d)\1{10}/)) return false;
  
  const calculateDigit = (slice) => {
    const sum = slice.split('')
      .map((num, idx) => parseInt(num) * (slice.length + 1 - idx))
      .reduce((a, b) => a + b);
    
    const remainder = 11 - (sum % 11);
    return remainder > 9 ? 0 : remainder;
  };

  return calculateDigit(cpf.slice(0,9)) === parseInt(cpf[9]) && 
         calculateDigit(cpf.slice(0,10)) === parseInt(cpf[10]);
};

// Criptografia Segura
const encryptData = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return {
    iv: iv.toString('hex'),
    content: encrypted,
    tag: cipher.getAuthTag().toString('hex')
  };
};

router.post('/create-pix-payment', 
  paymentLimiter,
  [
    body('amount').isFloat({ min: 1 }).toFloat(),
    body('user.cpf').custom(validateCPF),
    body('user.email').isEmail().normalizeEmail(),
    body('user.name').trim().escape().isLength({ min: 5 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const connection = await req.db.getConnection();
    try {
      const { amount, user } = req.body;
      
      // Verificar duplicatas
      const [existing] = await connection.query(
        `SELECT id FROM payments 
         WHERE user_id = ? AND status = 'pending' 
         AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [user.id]
      );
      
      if (existing.length > 0) {
        return res.status(429).json({ error: 'Pagamento pendente já existe' });
      }

      // Obter credenciais com segurança
      const [credentials] = await connection.query(
        `SELECT access_token, public_key 
         FROM api_keys 
         WHERE environment = ? 
         LIMIT 1`,
        [process.env.NODE_ENV || 'sandbox']
      );

      // Dados de pagamento
      const paymentId = uuidv4();
      const payload = {
        transaction_amount: amount,
        payment_method_id: 'pix',
        payer: {
          email: user.email,
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
            unit_price: amount
          }]
        },
        external_reference: paymentId,
        date_of_expiration: new Date(Date.now() + PIX_EXPIRATION).toISOString()
      };

      // Chamada segura à API do Mercado Pago
      const response = await axios.post(`${MP_API_URL}/payments`, payload, {
        headers: {
          'Authorization': `Bearer ${credentials[0].access_token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': crypto.createHash('sha256').update(paymentId).digest('hex')
        },
        timeout: 10000
      });

      // Armazenamento seguro
      const encryptedCPF = encryptData(user.cpf);
      await connection.query(
        `INSERT INTO payments 
         (mp_payment_id, user_id, amount, pix_data, status, encrypted_cpf)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          response.data.id,
          user.id,
          amount,
          JSON.stringify(response.data.point_of_interaction.transaction_data),
          'pending',
          encryptedCPF
        ]
      );

      // Resposta sanitizada
      const responseData = {
        paymentId: response.data.id,
        qrCode: response.data.point_of_interaction.transaction_data.qr_code,
        expires: response.data.date_of_expiration
      };

      res.json(responseData);

    } catch (error) {
      // Log seguro de erros
      await connection.query(
        `INSERT INTO security_logs 
         (event_type, ip_address, user_agent, metadata)
         VALUES (?, ?, ?, ?)`,
        ['payment_error', req.ip, req.get('User-Agent'), JSON.stringify({
          error: error.message,
          code: error.response?.status
        })]
      );

      res.status(500).json({ 
        error: 'Erro no processamento do pagamento',
        code: 'INTERNAL_ERROR'
      });
    } finally {
      connection.release();
    }
  }
);

router.post('/payment/webhook', 
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // Verificação HMAC
      const signature = req.headers['x-signature'];
      const hmac = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET);
      const digest = hmac.update(req.body).digest('hex');
      
      if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
        return res.status(401).send('Assinatura inválida');
      }

      const payload = JSON.parse(req.body.toString());
      const connection = await req.db.getConnection();
      
      // Atualização transacional
      await connection.beginTransaction();
      try {
        await connection.query(
          `UPDATE payments 
           SET status = ?, updated_at = NOW()
           WHERE mp_payment_id = ?`,
          [payload.data.status, payload.data.id]
        );

        if (payload.data.status === 'approved') {
          await connection.query(
            `UPDATE users 
             SET premium_status = 'active',
                 premium_expires = DATE_ADD(NOW(), INTERVAL 1 MONTH)
             WHERE id = ?`,
            [payload.data.metadata.user_id]
          );
        }
        
        await connection.commit();
        res.sendStatus(200);
      } catch (transactionError) {
        await connection.rollback();
        throw transactionError;
      }
    } catch (error) {
      console.error('Webhook Error:', error);
      res.status(400).send('Requisição inválida');
    }
  }
);

module.exports = router;