const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('../config');

// Configuração do pool PostgreSQL
const pool = new Pool(config.dbConfig.postgres);

// Tipos de planos
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
  'Content-Type': 'application/json',
  'X-Idempotency-Key': '' // Será preenchido dinamicamente
};

router.use((req, res, next) => {
  req.db = pool;
  next();
});

router.post('/create-payment', async (req, res) => {
  let client;
  try {
    // Verificação da conexão
    client = await pool.connect();
    const testResult = await client.query('SELECT 1 + 1 AS result');
    console.log('Teste de conexão bem-sucedido:', testResult.rows[0].result === 2);

    const { paymentMethod, plan, userData } = req.body;

    // Validações
    if (!plan || !plan.type) {
      return res.status(400).json({
        error: 'Plano inválido',
        message: 'Tipo de plano não especificado'
      });
    }

    if (!validatePaymentData(req.body)) {
      return res.status(400).json({
        error: 'Dados inválidos',
        message: 'Verifique os campos obrigatórios (CPF, email, tipo de plano)'
      });
    }

    // Busca o plano no banco
    const dbPlan = await getPlanFromDatabase(client, plan.type.toLowerCase());

    const validatedPlan = {
      type: dbPlan.type,
      price: parseFloat(dbPlan.price), // Conversão explícita
      duration: dbPlan.duration_months,
      label: dbPlan.description,
      period: getPlanPeriod(dbPlan.duration_months)
    };

    // Processa pagamento PIX
    if (paymentMethod === 'pix') {
      return await handlePixPayment(client, res, validatedPlan, userData);
    }

    return res.status(400).json({
      error: 'Método não suportado',
      supportedMethods: ['pix']
    });

  } catch (error) {
    console.error('Erro no processamento:', error);
    const statusCode = error.message.includes('Plano') ? 400 : 500;
    return res.status(statusCode).json({
      error: error.message.includes('Plano') ? error.message : 'Erro interno',
      details: error.response?.data || error.message
    });
  } finally {
    if (client) client.release();
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

async function getPlanFromDatabase(client, planType) {
  try {
    const query = {
      text: 'SELECT * FROM plans WHERE LOWER(type) = $1',
      values: [planType]
    };

    const result = await client.query(query);

    if (result.rows.length === 0) {
      throw new Error(`Plano '${planType}' não encontrado`);
    }

    return result.rows[0];
  } catch (error) {
    console.error('Erro ao buscar plano:', error);
    throw error;
  }
}

function getPlanPeriod(durationMonths) {
  const periods = {
    1: 'monthly',
    3: 'quarterly',
    12: 'annual'
  };
  return periods[durationMonths] || 'custom';
}

async function handlePixPayment(user, paymentData, res) {
  try {
    // Validação do usuário
    if (!user || !user.id) {
      throw new Error('Usuário inválido para processamento de pagamento');
    }

    // Montagem do payload para Mercado Pago
    const payloadMP = {
      transaction_amount: paymentData.transaction_amount,
      payment_method_id: "pix",
      payer: {
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        identification: {
          type: "CPF",
          number: user.cpf
        }
      },
      notification_url: process.env.MP_WEBHOOK_URL,
      description: paymentData.description,
      external_reference: paymentData.external_reference,
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutos de expiração
    };

    // Debug: Exibir payload
    console.log('Payload enviado ao Mercado Pago:', JSON.stringify(payloadMP, null, 2));

    // Envio para API do Mercado Pago
    const paymentResult = await mercadopago.payment.create(payloadMP);

    // Extrair tipo de plano da descrição (assume formato "Texto - [plan_type]")
    const planType = payloadMP.description.includes('-') 
      ? payloadMP.description.split('-').pop().trim()
      : 'unknown';

    // Registro no banco de dados com plan_type
    const registeredPayment = await registerPayment(
      user.id,
      paymentResult.body.id,
      payloadMP.transaction_amount,
      'pending', // Status inicial
      'pix', // Método de pagamento
      payloadMP.external_reference,
      planType // Novo campo adicionado
    );

    // Montagem da resposta
    const responseData = {
      paymentId: paymentResult.body.id,
      qrCode: paymentResult.body.point_of_interaction.transaction_data.qr_code,
      qrCodeBase64: paymentResult.body.point_of_interaction.transaction_data.qr_code_base64,
      paymentStatus: paymentResult.body.status,
      planType: planType,
      externalReference: payloadMP.external_reference
    };

    console.log('Pagamento registrado com sucesso:', responseData);
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Erro detalhado no Mercado Pago:', {
      message: error.message,
      responseData: error.body,
      stack: error.stack
    });

    // Tratamento específico para erros de banco de dados
    if (error.message.includes('column "plan_type"')) {
      throw new Error(`Erro de configuração do banco de dados: ${error.message}`);
    }

    throw new Error(`Falha na comunicação com o gateway de pagamento: ${error.message}`);
  }
}

// Validação de dados do pagamento
function validatePaymentData(data) {
  const cpfRegex = /^\d{11}$/;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Verificação hierárquica com logs detalhados
  if (!data.plan) {
    console.error('Plano ausente:', data);
    return false;
  }

  if (!data.plan.type || !Object.values(PLAN_TYPES).includes(data.plan.type)) {
    console.error('Tipo de plano inválido:', {
      receivedType: data.plan.type,
      validTypes: Object.values(PLAN_TYPES)
    });
    return false;
  }

  if (!data.userData?.cpf || !cpfRegex.test(data.userData.cpf)) {
    console.error('CPF inválido:', data.userData?.cpf);
    return false;
  }

  if (!data.userData?.email || !emailRegex.test(data.userData.email)) {
    console.error('Email inválido:', data.userData?.email);
    return false;
  }

  return true;
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
async function registerPayment(
  userId,
  transactionId,
  amount,
  status,
  paymentMethod,
  externalReference,
  planType // Novo parâmetro adicionado
) {
  try {
    const query = `
      INSERT INTO payments (
        user_id,
        transaction_id,
        amount,
        status,
        payment_method,
        external_reference,
        plan_type, // Coluna adicionada
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *`;
    
    const values = [
      userId,
      transactionId,
      amount,
      status,
      paymentMethod,
      externalReference,
      planType // Novo valor adicionado
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('Erro ao registrar pagamento:', error);
    throw new Error('Erro ao registrar pagamento no banco de dados');
  }
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