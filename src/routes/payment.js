// paymentRoutes.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const pool = require('../config'); // Configuração do PostgreSQL

// Configurações da API do Mercado Pago
const MP_API_URL = 'https://api.mercadopago.com/v1';
const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

const mpHeaders = {
  'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

// Rota principal de pagamento
router.post('/create-payment', async (req, res) => {
  try {
    const { paymentMethod, plan, userData } = req.body;

    // Validação reforçada
    if (!validatePaymentData(req.body)) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    // Verificação de preço no servidor
    if (!validatePlanPrice(plan)) {
      return res.status(400).json({ error: 'Valor do plano inválido' });
    }

    if (paymentMethod === 'pix') {
      return handlePixPayment(res, plan, userData);
    }

    return res.status(400).json({ error: 'Método de pagamento não suportado' });

  } catch (error) {
    console.error('Erro no processamento:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Erro interno',
      details: error.response?.data?.error || error.message
    });
  }
});

// Webhook completo com verificação de assinatura
router.post('/pix/webhook', express.json(), async (req, res) => {
  try {
    // Verificação de segurança
    if (!verifyWebhookSignature(req)) {
      console.warn('Tentativa de webhook não autorizada');
      return res.status(403).send('Acesso não autorizado');
    }

    const paymentId = req.body.data?.id;
    if (!paymentId) {
      return res.status(400).send('ID de pagamento inválido');
    }

    // Buscar detalhes do pagamento
    const paymentInfo = await getPaymentDetails(paymentId);
    
    // Atualizar status no banco de dados
    await updatePaymentStatus(paymentInfo);

    if (paymentInfo.status === 'approved') {
      await activateSubscription(paymentInfo);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).send('Erro interno');
  }
});

// Funções auxiliares
async function handlePixPayment(res, plan, userData) {
  const externalReference = uuidv4();
  
  const paymentData = {
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
    date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutos
  };

  try {
    const response = await axios.post(`${MP_API_URL}/payments`, paymentData, {
      headers: mpHeaders
    });

    const pixData = response.data.point_of_interaction.transaction_data;
    
    // Registrar no banco de dados
    const dbPayment = await registerPayment({
      external_reference: externalReference,
      mercadopago_id: response.data.id,
      amount: plan.price,
      status: response.data.status,
      payment_method: 'pix',
      user_email: userData.email,
      user_cpf: userData.cpf,
      qr_code: pixData.qr_code,
      qr_code_base64: pixData.qr_code_base64,
      expiration: pixData.date_of_expiration
    });

    res.json({
      paymentId: dbPayment.id,
      qrCode: pixData.qr_code,
      qrCodeBase64: pixData.qr_code_base64,
      expires: pixData.date_of_expiration
    });

  } catch (error) {
    console.error('Erro na API Mercado Pago:', error.response?.data);
    throw new Error('Falha ao criar pagamento PIX');
  }
}

// Validação de dados
function validatePaymentData(data) {
  const cpfRegex = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  return (
    data.plan?.price &&
    data.userData?.cpf &&
    cpfRegex.test(data.userData.cpf) &&
    emailRegex.test(data.userData.email) &&
    typeof data.plan.price === 'number'
  );
}

function validatePlanPrice(plan) {
  const validPrices = {
    monthly: 97.00,
    annual: 997.00
  };
  return Object.values(validPrices).includes(plan.price);
}

// Verificação de webhook com HMAC
function verifyWebhookSignature(req) {
  try {
    const signature = req.headers['x-signature'];
    if (!signature || !MP_WEBHOOK_SECRET) return false;

    const elements = signature.split(',');
    const timestamp = elements.find(e => e.startsWith('ts='))?.split('=')[1];
    const receivedHash = elements.find(e => e.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !receivedHash) return false;

    const payload = `${timestamp}.${JSON.stringify(req.body)}`;
    const generatedHash = crypto
      .createHmac('sha256', MP_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    return generatedHash === receivedHash;
  } catch (error) {
    console.error('Erro na verificação de assinatura:', error);
    return false;
  }
}

// Funções de banco de dados
async function registerPayment(paymentData) {
  const query = `
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
      expiration
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`;
  
  const values = [
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

  const { rows } = await pool.query(query, values);
  return rows[0];
}

async function getPaymentDetails(paymentId) {
  const response = await axios.get(`${MP_API_URL}/payments/${paymentId}`, {
    headers: mpHeaders
  });
  return response.data;
}

async function updatePaymentStatus(paymentInfo) {
  const query = `
    UPDATE payments 
    SET 
      status = $1,
      updated_at = NOW()
    WHERE mercadopago_id = $2
    RETURNING *`;
  
  const values = [paymentInfo.status, paymentInfo.id];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

async function activateSubscription(paymentInfo) {
  const query = await pool.query(
    'SELECT * FROM payments WHERE mercadopago_id = $1',
    [paymentInfo.id]
  );
  
  const payment = query.rows[0];
  if (!payment) throw new Error('Pagamento não encontrado');

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(startDate.getMonth() + (payment.amount === 97.00 ? 1 : 12));

  const subscriptionQuery = `
    INSERT INTO subscriptions (
      payment_id,
      user_email,
      plan_type,
      start_date,
      end_date,
      active
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`;
  
  const values = [
    payment.id,
    payment.user_email,
    payment.amount === 97.00 ? 'monthly' : 'annual',
    startDate,
    endDate,
    true
  ];

  await pool.query(subscriptionQuery, values);
}

module.exports = router;