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
      return await handlePixPayment(client, res, dbPlan, userData); // Enviar dbPlan direto
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

    return res.json({ status: 'success' });

  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

async function getPlanFromDatabase(client, planType) {
  try {
    const query = {
      text: 'SELECT type, price::float, duration_months, description FROM plans WHERE LOWER(type) = $1',
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

async function handlePixPayment(client, res, dbPlan, userData) {
  try {

    if (!config.baseUrl) {
      throw new Error('Configuração baseUrl não encontrada');
    }
    // Validação robusta do plano e preço
    if (!dbPlan || typeof dbPlan.price === 'undefined') {
      throw new Error('Plano inválido ou preço não encontrado');
    }

    // Conversão explícita e validação do tipo numérico
    const transactionAmount = Number(dbPlan.price);
    if (isNaN(transactionAmount)) {
      throw new Error(`Valor do plano inválido: ${dbPlan.price} (Tipo: ${typeof dbPlan.price})`);
    }

    // Validação dos dados do usuário
    if (!userData?.cpf || !userData?.email) {
      throw new Error('Dados do usuário incompletos para processamento');
    }

    // Geração de ID único para idempotência
    const externalReference = uuidv4();

    // Log de depuração detalhado
    console.log('Dados para Mercado Pago:', {
      amountType: typeof transactionAmount,
      amountValue: transactionAmount,
      planType: dbPlan.type,
      userCPF: userData.cpf
    });

    // Montagem do payload com tipos corretos
    const payloadMP = {
      transaction_amount: transactionAmount,
      payment_method_id: "pix",
      payer: {
        email: userData.email,
        first_name: userData.name?.split(' ')[0] || '',
        last_name: userData.name?.split(' ').slice(1).join(' ') || '',
        identification: {
          type: "CPF",
          number: userData.cpf
        }
      },
      notification_url: `${config.baseUrl}/pix/webhook`,
      description: `Assinatura ${dbPlan.type} - ${dbPlan.description || 'Plano Premium'}`,
      external_reference: externalReference,
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    };

    // Envio com headers atualizados
    const response = await axios.post(`${MP_API_URL}/payments`, payloadMP, {
      headers: {
        ...mpHeaders,
        'X-Idempotency-Key': externalReference,
        'X-Debug-Mode': 'true' // Header adicional para diagnóstico
      },
      timeout: 10000 // Aumento do timeout
    });

    const registeredPayment = await registerPayment(
      userData.email,
      userData.cpf,
      response.data.id,  // Agora vai para mercadopago_id
      transactionAmount,
      'pending',
      'pix',
      externalReference,
      dbPlan.type
    );

    // Formatação da resposta com dados completos
    const responseData = {
      payment_id: response.data.id,
      qr_code: response.data.point_of_interaction?.transaction_data?.qr_code || '',
      qr_code_base64: response.data.point_of_interaction?.transaction_data?.qr_code_base64 || '',
      ticket_url: response.data.point_of_interaction?.transaction_data?.ticket_url || '',
      expiration_date: response.data.date_of_expiration,
      external_reference: externalReference,
      debug: {
        mp_status: response.status,
        amount_sent: transactionAmount
      }
    };

    console.log('Pagamento registrado com sucesso:', JSON.stringify({
      paymentId: responseData.payment_id,
      amount: transactionAmount,
      user: userData.email.slice(0, 3) + '...' // Log seguro
    }, null, 2));

    return res.status(200).json(responseData);

  } catch (error) {
    // Log detalhado do erro
    console.error('Erro completo no PIX:', {
      errorMessage: error.message,
      stack: error.stack,
      requestData: error.config?.data ? JSON.parse(error.config.data) : null,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    });

    // Resposta adaptada para diferentes tipos de erro
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error === 'bad_request'
      ? 'Erro na validação dos dados'
      : 'Falha no processamento do pagamento';

    return res.status(statusCode).json({
      error: errorMessage,
      details: {
        code: error.response?.data?.cause?.[0]?.code || 'unknown',
        description: error.response?.data?.cause?.[0]?.description || error.message,
        field: error.response?.data?.cause?.[0]?.field || 'general'
      }
    });
  }
}

// Função validatePaymentData corrigida
function validatePaymentData(data) {
  const cpfRegex = /^\d{11}$/;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Validação hierárquica detalhada
  if (!data.userData) {
    console.error('Dados do usuário ausentes:', data);
    return false;
  }

  if (!data.userData.cpf || !cpfRegex.test(data.userData.cpf)) {
    console.error('CPF inválido:', data.userData.cpf);
    return false;
  }

  if (!data.userData.email || !emailRegex.test(data.userData.email)) {
    console.error('Email inválido:', data.userData.email);
    return false;
  }

  if (!data.plan || !Object.values(PLAN_TYPES).includes(data.plan.type.toLowerCase())) {
    console.error('Tipo de plano inválido:', {
      received: data.plan?.type,
      valid: Object.values(PLAN_TYPES)
    });
    return false;
  }

  return true; // Removida verificação do price
}

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
    
    // Adicionar mapeamento do ID correto
    return {
      ...response.data,
      id: response.data.id,        // Mantém compatibilidade
      mercadopago_id: response.data.id  // Novo mapeamento
    };
    
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
  tempEmail,
  tempCpf,
  mercadopagoId,  // Nome do parâmetro alterado
  amount,
  status,
  paymentMethod,
  externalReference,
  planType
) {
  let queryText;
  let values;

  try {
    queryText = `
      INSERT INTO payments (
        temp_email,
        temp_cpf,
        mercadopago_id,  // Coluna corrigida
        amount,
        status,
        payment_method,
        external_reference,
        plan_type,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *`;

    values = [
      tempEmail,
      tempCpf,
      mercadopagoId,  // Valor corrigido
      amount,
      status,
      paymentMethod,
      externalReference,
      planType
    ];

    const result = await pool.query(queryText, values);
    return result.rows[0];

  } catch (error) {
    console.error('Erro detalhado ao registrar pagamento:', {
      errorMessage: error.message,
      stack: error.stack,
      query: queryText,
      values: values
    });
    throw new Error(`Falha ao registrar pagamento: ${error.message}`);
  }
}

async function createUserIfNotExists(client, userData) {
  try {
    // Verificar se usuário já existe
    const existingUser = await client.query(
      `SELECT * FROM users 
       WHERE email = $1 OR cpf = $2 
       LIMIT 1`,
      [userData.email, userData.cpf]
    );

    if (existingUser.rowCount > 0) {
      console.log('Usuário já existente:', existingUser.rows[0].id);
      return existingUser.rows[0];
    }

    // Criar novo usuário
    const newUserQuery = `
      INSERT INTO users (
        email,
        cpf,
        created_at,
        updated_at
      ) VALUES ($1, $2, NOW(), NOW())
      RETURNING *`;

    const newUserResult = await client.query(newUserQuery, [
      userData.email,
      userData.cpf
    ]);

    console.log('Novo usuário criado:', JSON.stringify(newUserResult.rows[0], null, 2));

    return newUserResult.rows[0];

  } catch (error) {
    console.error('Erro detalhado ao criar usuário:', {
      email: userData.email,
      errorMessage: error.message,
      stack: error.stack
    });

    throw new Error(`Falha ao criar usuário: ${error.message}`);
  }
}

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

module.exports = router;