// paymentRoutes.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Configurações da API do Mercado Pago
const MP_API_URL = 'https://api.mercadopago.com/v1';
const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

const mpHeaders = {
  'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

// Rota principal para criação de pagamentos
router.post('/create-payment', async (req, res) => {
  try {
    const { paymentMethod, plan, userData } = req.body;
    const pool = req.db;

    // Validação dos dados recebidos
    if (!validatePaymentData(req.body)) {
      return res.status(400).json({
        error: 'Dados inválidos',
        message: 'Verifique os campos obrigatórios e formatos (CPF, email, valores numéricos)'
      });
    }

    // Validação do preço do plano
    if (!validatePlanPrice(plan)) {
      return res.status(400).json({
        error: 'Valor do plano inválido',
        validValues: { mensal: 97.00, anual: 997.00 }
      });
    }

    // Processamento para pagamentos PIX
    if (paymentMethod === 'pix') {
      return await handlePixPayment(pool, res, plan, userData);
    }

    // Resposta para métodos não implementados
    return res.status(400).json({
      error: 'Método de pagamento não suportado',
      supportedMethods: ['pix']
    });

  } catch (error) {
    console.error('Erro no processamento do pagamento:', {
      message: error.message,
      stack: error.stack,
      responseData: error.response?.data
    });

    return res.status(500).json({
      error: 'Erro interno no processamento do pagamento',
      details: error.response?.data?.error || error.message,
      referenceId: uuidv4()
    });
  }
});

// Rota para webhook de notificações PIX
router.post('/pix/webhook', express.json(), async (req, res) => {
  try {
    const pool = req.db;

    // Verificação de segurança do webhook
    if (!verifyWebhookSignature(req)) {
      console.warn('Tentativa de acesso não autorizado ao webhook', {
        headers: req.headers,
        body: req.body
      });
      return res.status(403).json({
        error: 'Acesso não autorizado',
        code: 'INVALID_SIGNATURE'
      });
    }

    // Extração do ID do pagamento
    const paymentId = req.body.data?.id;
    if (!paymentId) {
      return res.status(400).json({
        error: 'ID de pagamento ausente na requisição',
        code: 'MISSING_PAYMENT_ID'
      });
    }

    // Obter detalhes atualizados do pagamento
    const paymentInfo = await getPaymentDetails(paymentId);
    
    // Atualização do status no banco de dados
    await updatePaymentStatus(pool, paymentInfo);

    // Ativação da assinatura se pagamento aprovado
    if (paymentInfo.status === 'approved') {
      await activateSubscription(pool, paymentInfo);
      console.log(`Assinatura ativada para pagamento ID: ${paymentInfo.id}`);
    }

    return res.status(200).json({
      status: 'success',
      message: 'Webhook processado com sucesso'
    });

  } catch (error) {
    console.error('Erro crítico no processamento do webhook:', {
      message: error.message,
      stack: error.stack,
      paymentId: req.body.data?.id
    });

    return res.status(500).json({
      error: 'Erro interno no processamento do webhook',
      referenceId: uuidv4()
    });
  }
});

// Função para tratamento de pagamentos PIX
async function handlePixPayment(pool, res, plan, userData) {
  const externalReference = uuidv4();
  
  // Construção do payload para API do Mercado Pago
  const paymentPayload = {
    transaction_amount: plan.price,
    payment_method_id: 'pix',
    payer: {
      email: userData.email,
      first_name: userData.name.split(' ')[0],
      last_name: userData.name.split(' ')[1] || '',
      identification: {
        type: 'CPF',
        number: userData.cpf.replace(/\D/g, '')
      }
    },
    notification_url: `${process.env.API_BASE_URL}/api/pix/webhook`,
    description: `Assinatura ${plan.label} - ${plan.period}`,
    external_reference: externalReference,
    date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };

  try {
    // Chamada para API do Mercado Pago
    const mpResponse = await axios.post(`${MP_API_URL}/payments`, paymentPayload, {
      headers: mpHeaders,
      timeout: 10000
    });

    const pixData = mpResponse.data.point_of_interaction.transaction_data;

    // Registro do pagamento no banco de dados
    const dbPayment = await registerPayment(pool, {
      external_reference: externalReference,
      mercadopago_id: mpResponse.data.id,
      amount: plan.price,
      status: mpResponse.data.status,
      payment_method: 'pix',
      user_email: userData.email,
      user_cpf: userData.cpf,
      qr_code: pixData.qr_code,
      qr_code_base64: pixData.qr_code_base64,
      expiration: pixData.date_of_expiration
    });

    // Resposta de sucesso
    return res.json({
      paymentId: dbPayment.id,
      qrCode: pixData.qr_code,
      qrCodeBase64: pixData.qr_code_base64,
      expires: pixData.date_of_expiration,
      merchantMessage: pixData.ticket_url ? `Pagamento disponível em: ${pixData.ticket_url}` : 'Gerado via API'
    });

  } catch (error) {
    console.error('Falha na integração com Mercado Pago:', {
      errorDetails: error.response?.data,
      statusCode: error.response?.status,
      requestData: paymentPayload
    });

    throw new Error(`Falha na comunicação com o gateway de pagamento: ${error.message}`);
  }
}

// Validação de dados do pagamento
function validatePaymentData(data) {
  const cpfRegex = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return (
    data.plan &&
    data.plan.price &&
    data.userData &&
    data.userData.cpf &&
    cpfRegex.test(data.userData.cpf) &&
    data.userData.email &&
    emailRegex.test(data.userData.email) &&
    typeof data.plan.price === 'number' &&
    !isNaN(data.plan.price)
  );
}

// Validação dos valores dos planos
function validatePlanPrice(plan) {
  const validPrices = new Set([97.00, 997.00]);
  return validPrices.has(plan.price);
}

// Verificação de assinatura HMAC
function verifyWebhookSignature(req) {
  try {
    const signatureHeader = req.headers['x-signature'];
    if (!signatureHeader || !MP_WEBHOOK_SECRET) return false;

    const signatureParts = signatureHeader.split(',');
    const timestamp = signatureParts.find(part => part.startsWith('ts='))?.split('=')[1];
    const receivedHash = signatureParts.find(part => part.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !receivedHash) return false;

    const payload = `${timestamp}.${JSON.stringify(req.body)}`;
    const generatedHash = crypto
      .createHmac('sha256', MP_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(receivedHash)
    );

  } catch (error) {
    console.error('Erro na verificação de segurança:', error);
    return false;
  }
}

// Função para obter detalhes do pagamento
async function getPaymentDetails(paymentId) {
  try {
    const response = await axios.get(`${MP_API_URL}/payments/${paymentId}`, {
      headers: mpHeaders,
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    console.error('Falha ao obter detalhes do pagamento:', {
      paymentId,
      status: error.response?.status,
      data: error.response?.data
    });
    throw new Error(`Erro na recuperação de dados do pagamento: ${error.message}`);
  }
}

// Função de registro do pagamento no banco de dados
async function registerPayment(pool, paymentData) {
  try {
    const queryText = `
      INSERT INTO payments (
        external_reference, 
        mercadopago_id, 
        amount, 
        status, 
        payment_method, 
        user_email, 
        user_cpf, 
        qr_code, 
        qr_code_base64, 
        expiration,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
      RETURNING *`;

    const queryValues = [
      paymentData.external_reference,
      paymentData.mercadopago_id,
      paymentData.amount,
      paymentData.status,
      paymentData.payment_method,
      paymentData.user_email,
      paymentData.user_cpf,
      paymentData.qr_code,
      paymentData.qr_code_base64,
      paymentData.expiration
    ];

    const result = await pool.query(queryText, queryValues);
    return result.rows[0];

  } catch (error) {
    console.error('Erro no registro do pagamento:', {
      error: error.message,
      code: error.code,
      query: error.query
    });
    throw new Error(`Falha no registro do pagamento: ${error.message}`);
  }
}

// Atualização do status do pagamento
async function updatePaymentStatus(pool, paymentInfo) {
  try {
    const queryText = `
      UPDATE payments 
      SET 
        status = $1,
        updated_at = NOW(),
        attempts = attempts + 1
      WHERE mercadopago_id = $2
      RETURNING *`;

    const result = await pool.query(queryText, [
      paymentInfo.status,
      paymentInfo.id
    ]);

    if (result.rowCount === 0) {
      throw new Error(`Pagamento não encontrado: ${paymentInfo.id}`);
    }

    return result.rows[0];

  } catch (error) {
    console.error('Erro na atualização do status:', {
      paymentId: paymentInfo.id,
      error: error.message
    });
    throw new Error(`Falha na atualização do status: ${error.message}`);
  }
}

// Ativação da assinatura do usuário
async function activateSubscription(pool, paymentInfo) {
  try {
    // Buscar dados completos do pagamento
    const paymentQuery = await pool.query(
      `SELECT * FROM payments 
       WHERE mercadopago_id = $1 
       AND status = 'approved'`,
      [paymentInfo.id]
    );

    if (paymentQuery.rowCount === 0) {
      throw new Error(`Pagamento aprovado não encontrado: ${paymentInfo.id}`);
    }

    const payment = paymentQuery.rows[0];
    const startDate = new Date();
    const endDate = new Date(startDate);

    // Determinar período da assinatura
    if (payment.amount === 97.00) {
      endDate.setMonth(startDate.getMonth() + 1);
    } else if (payment.amount === 997.00) {
      endDate.setFullYear(startDate.getFullYear() + 1);
    } else {
      throw new Error(`Valor de pagamento inválido para assinatura: ${payment.amount}`);
    }

    // Registrar assinatura
    const subscriptionQuery = `
      INSERT INTO subscriptions (
        payment_id,
        user_email,
        plan_type,
        start_date,
        end_date,
        active,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (user_email) 
      DO UPDATE SET
        plan_type = EXCLUDED.plan_type,
        end_date = EXCLUDED.end_date,
        active = EXCLUDED.active,
        updated_at = NOW()
      RETURNING *`;

    const subscriptionValues = [
      payment.id,
      payment.user_email,
      payment.amount === 97.00 ? 'monthly' : 'annual',
      startDate,
      endDate,
      true
    ];

    await pool.query(subscriptionQuery, subscriptionValues);

  } catch (error) {
    console.error('Falha na ativação da assinatura:', {
      paymentId: paymentInfo.id,
      error: error.message
    });
    throw new Error(`Erro na ativação da assinatura: ${error.message}`);
  }
}

module.exports = router;