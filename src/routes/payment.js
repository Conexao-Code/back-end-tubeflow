// paymentRoutes.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const PLAN_TYPES = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  ANNUAL: 'annual'
};

const MP_API_URL = 'https://api.mercadopago.com/v1';
const MP_ACCESS_TOKEN = "TEST-124639488725733-022019-b62d2acb8e137c40629a18b9dc7571df-1254217648";
const MP_WEBHOOK_SECRET = "9dcee93ad0b999bc005ed723554e8f7cdd7021d036f1f043a39ee966af668dc3";

const mpHeaders = {
  'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

router.post('/create-payment', async (req, res) => {
  try {
    const { paymentMethod, plan, userData } = req.body;
    const pool = req.db;

    if (!validatePaymentData(req.body)) {
      return res.status(400).json({
        error: 'Dados inválidos',
        message: 'Verifique os campos obrigatórios (CPF, email, tipo de plano)'
      });
    }

    const dbPlan = await getPlanFromDatabase(pool, plan.type);
    
    const validatedPlan = {
      type: plan.type,
      price: dbPlan.price,
      duration: dbPlan.duration_months,
      label: dbPlan.name,
      period: getPlanPeriod(dbPlan.duration_months)
    };

    if (paymentMethod === 'pix') {
      return await handlePixPayment(pool, res, validatedPlan, userData);
    }

    return res.status(400).json({
      error: 'Método de pagamento não suportado',
      supportedMethods: ['pix']
    });

  } catch (error) {
    console.error('Erro no processamento do pagamento:', error);

    const statusCode = error.message.includes('Plano') ? 400 : 500;
    return res.status(statusCode).json({
      error: error.message.includes('Plano') 
        ? error.message 
        : 'Erro interno no processamento do pagamento',
      details: error.response?.data?.error || error.message
    });
  }
});

// Rota para webhook de notificações PIX
router.post('/pix/webhook', express.json(), async (req, res) => {
  try {
    const pool = req.db;

    if (!verifyWebhookSignature(req)) {
      return res.status(403).json({ error: 'Acesso não autorizado' });
    }

    const paymentId = req.body.data?.id;
    if (!paymentId) return res.status(400).json({ error: 'ID de pagamento ausente' });

    const paymentInfo = await getPaymentDetails(paymentId);
    await updatePaymentStatus(pool, paymentInfo);

    if (paymentInfo.status === 'approved') {
      await activateSubscription(pool, paymentInfo);
    }

    return res.json({ status: 'success' });

  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

async function getPlanFromDatabase(pool, planType) {
  const result = await pool.query(
    `SELECT * FROM plans 
     WHERE LOWER(name) = LOWER($1)`,
    [planType]
  );

  if (!result.rows.length) {
    throw new Error('Plano não encontrado');
  }

  return result.rows[0];
}

function getPlanPeriod(durationMonths) {
  const periods = {
    1: 'monthly',
    3: 'quarterly',
    12: 'annual'
  };
  return periods[durationMonths] || 'custom';
}

// Função para tratamento de pagamentos PIX
async function handlePixPayment(pool, res, plan, userData) {
  const externalReference = uuidv4();

  if (!userData.cpf || userData.cpf.length !== 11) {
    return res.status(400).json({
      error: 'CPF inválido',
      message: 'O CPF deve conter 11 dígitos numéricos'
    });
  }
  
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
    const mpResponse = await axios.post(`${MP_API_URL}/payments`, paymentPayload, {
      headers: mpHeaders,
      timeout: 10000
    });

    const pixData = mpResponse.data.point_of_interaction.transaction_data;

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
      expiration: pixData.date_of_expiration,
      plan_type: plan.type
    });

    return res.json({
      paymentId: dbPayment.id,
      qrCode: pixData.qr_code,
      qrCodeBase64: pixData.qr_code_base64,
      expires: pixData.date_of_expiration
    });

  } catch (error) {
    console.error('Erro no Mercado Pago:', error.response?.data);
    throw new Error('Falha na comunicação com o gateway de pagamento');
  }
}

// Validação de dados do pagamento
function validatePaymentData(data) {
  const cpfRegex = /^\d{11}$/; // Regex modificado
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const isValid = (
    data.plan &&
    data.plan.type &&
    Object.values(PLAN_TYPES).includes(data.plan.type) &&
    data.userData &&
    cpfRegex.test(data.userData.cpf) &&
    emailRegex.test(data.userData.email)
  );

  if (!isValid) {
    console.log('Dados inválidos:', {
      cpf: data.userData?.cpf,
      email: data.userData?.email,
      planType: data.plan?.type
    });
  }

  return isValid;
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
      plan_type,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
    RETURNING *`;

  const result = await pool.query(queryText, [
    paymentData.external_reference,
    paymentData.mercadopago_id,
    paymentData.amount,
    paymentData.status,
    paymentData.payment_method,
    paymentData.user_email,
    paymentData.user_cpf,
    paymentData.qr_code,
    paymentData.qr_code_base64,
    paymentData.expiration,
    paymentData.plan_type
  ]);

  return result.rows[0];
}

async function activateSubscription(pool, paymentInfo) {
  const paymentQuery = await pool.query(
    `SELECT p.*, pl.duration_months 
     FROM payments p
     JOIN plans pl ON p.plan_type = pl.name
     WHERE p.mercadopago_id = $1`,
    [paymentInfo.id]
  );

  if (!paymentQuery.rowCount) {
    throw new Error('Pagamento não encontrado');
  }

  const payment = paymentQuery.rows[0];
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(startDate.getMonth() + payment.duration_months);

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
      updated_at = NOW()`;

  await pool.query(subscriptionQuery, [
    payment.id,
    payment.user_email,
    payment.plan_type,
    startDate,
    endDate,
    true
  ]);
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