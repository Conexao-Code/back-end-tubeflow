const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('../config');
const bcrypt = require('bcrypt'); 

// Configuração do pool PostgreSQL
const pool = new Pool(config.dbConfig.postgres);

// Tipos de planos
const PLAN_TYPES = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  ANNUAL: 'annual'
};

const MP_API_URL = 'https://api.mercadopago.com/v1';
const MP_ACCESS_TOKEN = "APP_USR-124639488725733-022019-59397774534a5f0f347f1bc940937a2e-1254217648";
const MP_WEBHOOK_SECRET = "9dcee93ad0b999bc005ed723554e8f7cdd7021d036f1f043a39ee966af668dc3";

const mpHeaders = {
  'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
  'X-Idempotency-Key': ''
};

router.use((req, res, next) => {
  req.db = pool;
  next();
});

router.post('/create-payment', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const testResult = await client.query('SELECT 1 + 1 AS result');
    console.log('Teste de conexão bem-sucedido:', testResult.rows[0].result === 2);

    const { paymentMethod, plan, userData } = req.body;

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

    const dbPlan = await getPlanFromDatabase(client, plan.type.toLowerCase());

    if (paymentMethod === 'pix') {
      return await handlePixPayment(client, res, dbPlan, userData);
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

router.get('/payments/:id/status', async (req, res) => {
  try {
    const payment = await getPaymentDetails(req.params.id);

    // Busca dados complementares do banco
    const dbPayment = await req.db.query(
      'SELECT plan_type, amount, user_email FROM payments WHERE mercadopago_id = $1',
      [payment.id]
    );

    const paymentData = dbPayment.rows[0] || {};
    const userEmail = paymentData.user_email;

    // Verifica se o usuário existe
    let userExists = false;
    if (userEmail) {
      const userCheck = await req.db.query(
        'SELECT id FROM users WHERE email = $1',
        [userEmail]
      );
      userExists = userCheck.rowCount > 0;
    }

    const responseData = {
      payment_id: payment.id,
      status: payment.status,
      last_updated: payment.updated_at,
      amount: paymentData.amount || payment.amount,
      plan_type: paymentData.plan_type || 'unknown',
      user_exists: userExists
    };

    res.json(responseData);

  } catch (error) {
    console.error('Erro na verificação de status:', error);
    res.status(500).json({
      error: 'Erro ao verificar status do pagamento',
      details: error.message
    });
  }
});

router.post('/create-account', async (req, res) => {
  const { email, companyName, password, paymentId } = req.body;
  const client = await req.db.connect();

  try {
    await client.query('BEGIN');

    // Validação de campos obrigatórios
    const requiredFields = ['email', 'companyName', 'password', 'paymentId'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Todos os campos são obrigatórios',
        missingFields,
        exampleRequest: {
          email: "user@example.com",
          companyName: "Empresa XYZ",
          password: "senhaSegura123",
          paymentId: "123456789"
        }
      });
    }

    // Verifica existência da empresa
    const companyCheck = await client.query(
      'SELECT id FROM companies WHERE name = $1',
      [companyName]
    );

    if (companyCheck.rowCount > 0) {
      return res.status(409).json({
        error: 'Empresa já cadastrada',
        solution: "Tente um nome diferente ou entre em contato com o suporte",
        field: 'companyName'
      });
    }

    // Criação da empresa com subdomínio único
    const subdomainSuffix = Math.random().toString(36).substring(2, 7);
    const cleanCompanyName = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 20);
    
    const companyResult = await client.query(
      `INSERT INTO companies (name, subdomain, active)
       VALUES ($1, $2, true)
       RETURNING id, subdomain`,
      [companyName, `${cleanCompanyName}-${subdomainSuffix}`]
    );

    const companyId = companyResult.rows[0].id;

    // Verificação de usuário existente
    const userCheck = await client.query(
      `SELECT id FROM users 
       WHERE email = $1 AND company_id = $2`,
      [email, companyId]
    );

    if (userCheck.rowCount > 0) {
      return res.status(409).json({
        error: 'Usuário já cadastrado nesta empresa',
        resolutionSteps: [
          "Recupere sua senha caso já possua cadastro",
          "Utilize um e-mail diferente"
        ],
        field: 'email'
      });
    }

    // Hash de senha seguro
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Criação do usuário admin
    const userResult = await client.query(
      `INSERT INTO users (company_id, name, email, password, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, role`,
      [companyId, 'Administrador', email, hashedPassword]
    );

    // Atualização segura do pagamento
    const paymentUpdate = await client.query(
      `UPDATE payments
       SET company_id = $1
       WHERE mercadopago_id = $2
       RETURNING id`,
      [companyId, paymentId]
    );

    if (paymentUpdate.rowCount === 0) {
      throw new Error(`Pagamento não encontrado: ${paymentId}`);
    }

    await client.query('COMMIT');

    // Geração de token JWT seguro
    const token = jwt.sign(
      {
        userId: userResult.rows[0].id,
        companyId,
        role: userResult.rows[0].role,
        iss: "api.tubeflow",
        aud: "client.tubeflow"
      },
      config.JWT_SECRET,
      { 
        expiresIn: '7d',
        algorithm: 'HS256'
      }
    );

    // Resposta formatada
    res.json({
      success: true,
      nextSteps: [
        "Armazene o token de acesso localmente",
        "Utilize o token em cabeçalhos Authorization: Bearer <token>"
      ],
      token: {
        value: token,
        expiresIn: "7 dias",
        type: "Bearer"
      },
      company: {
        id: companyId,
        name: companyName,
        subdomain: companyResult.rows[0].subdomain,
        onboardingStatus: "completed"
      },
      user: {
        id: userResult.rows[0].id,
        email: email,
        role: "admin"
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    
    // Log detalhado para diagnóstico
    console.error('Erro completo:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      timestamp: new Date().toISOString()
    });

    // Tratamento de erros específicos
    const errorResponse = {
      error: 'Erro no processo de criação',
      details: error.message,
      systemAction: "Rollback completo realizado",
      userAction: [
        "Verifique os dados enviados",
        "Tente novamente em alguns minutos"
      ]
    };

    if (error.code === '23505') {
      errorResponse.error = "Conflito de dados únicos";
      errorResponse.field = error.constraint.includes('email') 
        ? 'email' 
        : 'companyName';
      errorResponse.status = 409;
    }

    res.status(errorResponse.status || 500).json(errorResponse);
  } finally {
    client.release();
  }
});

// Atualize a função updatePaymentStatus
async function updatePaymentStatus(pool, paymentInfo) {
  const queryText = `
    UPDATE payments 
    SET 
      status = $1,
      updated_at = NOW(),
      attempts = attempts + 1
    WHERE mercadopago_id = $2 
    RETURNING *`;

  try {
    const result = await pool.query(queryText, [
      paymentInfo.status.toLowerCase(), // Normaliza o status
      paymentInfo.id
    ]);

    if (result.rowCount === 0) {
      throw new Error(`Pagamento não encontrado: ${paymentInfo.id}`);
    }

    return {
      ...result.rows[0],
      mercadopago_id: paymentInfo.id // Mantém compatibilidade
    };

  } catch (error) {
    console.error('Erro na atualização:', error.message);
    throw new Error(`Falha na atualização: ${error.message}`);
  }
}

// Atualize a função getPaymentDetails
async function getPaymentDetails(paymentId) {
  try {
    const response = await axios.get(`${MP_API_URL}/payments/${paymentId}`, {
      headers: mpHeaders,
      timeout: 5000
    });

    // Mapeamento completo do status
    const statusMapping = {
      'pending': 'pending',
      'approved': 'approved',
      'authorized': 'authorized',
      'in_process': 'in_analysis',
      'in_mediation': 'in_dispute',
      'rejected': 'rejected',
      'cancelled': 'canceled',
      'refunded': 'refunded',
      'charged_back': 'chargeback'
    };

    // Busca detalhes do banco de dados
    const dbPayment = await pool.query(
      'SELECT plan_type FROM payments WHERE mercadopago_id = $1',
      [paymentId]
    );

    return {
      ...response.data,
      id: response.data.id,
      status: statusMapping[response.data.status] || 'unknown',
      amount: response.data.transaction_amount,
      plan_type: dbPayment.rows[0]?.plan_type || 'unknown'
    };

  } catch (error) {
    console.error('Falha ao obter detalhes do pagamento:', {
      paymentId,
      status: error.response?.status,
      data: error.response?.data
    });
    throw new Error(`Erro na recuperação de dados: ${error.message}`);
  }
}

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

    const transactionAmount = Number(dbPlan.price);
    if (isNaN(transactionAmount)) {
      throw new Error(`Valor do plano inválido: ${dbPlan.price}`);
    }

    if (!userData?.cpf || !userData?.email) {
      throw new Error('Dados do usuário incompletos');
    }

    const externalReference = uuidv4();
    const pixPayload = {
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

    const mpResponse = await axios.post(`${MP_API_URL}/payments`, pixPayload, {
      headers: {
        ...mpHeaders,
        'X-Idempotency-Key': externalReference,
        'X-Debug-Mode': 'true'
      },
      timeout: 10000
    });

    await registerPayment(
      userData.email,
      userData.cpf,
      mpResponse.data.id,
      transactionAmount,
      'pending',
      'pix',
      externalReference,
      dbPlan.type
    );

    const transactionData = mpResponse.data.point_of_interaction?.transaction_data || {};
    const responseData = {
      payment_id: mpResponse.data.id,
      qr_code: transactionData.qr_code || '',
      qr_code_base64: transactionData.qr_code_base64 || '',
      ticket_url: transactionData.ticket_url || '',
      expiration_date: mpResponse.data.date_of_expiration,
      external_reference: externalReference,
      payment_details: {
        amount: transactionAmount,
        payer_name: userData.name,
        payer_email: userData.email,
        payer_cpf: userData.cpf,
        plan_type: dbPlan.type,
        created_at: new Date().toISOString()
      }
    };

    console.log('Pagamento PIX registrado:', JSON.stringify({
      paymentId: responseData.payment_id,
      amount: transactionAmount,
      user: userData.email
    }, null, 2));

    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Erro completo no PIX:', {
      errorMessage: error.message,
      stack: error.stack,
      requestData: error.config?.data,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    });

    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error === 'bad_request'
      ? 'Erro na validação dos dados'
      : 'Falha no processamento do pagamento';

    return res.status(statusCode).json({
      error: errorMessage,
      details: error.response?.data || error.message
    });
  }
}

function validatePaymentData(data) {
  const cpfRegex = /^\d{11}$/;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!data.userData || !data.plan) return false;

  return cpfRegex.test(data.userData.cpf) &&
    emailRegex.test(data.userData.email) &&
    Object.values(PLAN_TYPES).includes(data.plan.type?.toLowerCase());
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

async function getPaymentDetails(paymentId) {
  try {
    const response = await axios.get(`${MP_API_URL}/payments/${paymentId}`, {
      headers: mpHeaders,
      timeout: 5000
    });

    return {
      ...response.data,
      mercadopago_id: response.data.id
    };

  } catch (error) {
    console.error('Falha ao obter detalhes do pagamento:', {
      paymentId,
      status: error.response?.status,
      data: error.response?.data
    });
    throw new Error(`Erro na recuperação de dados: ${error.message}`);
  }
}

async function registerPayment(
  userEmail,
  userCpf,
  mercadopagoId,
  amount,
  status,
  paymentMethod,
  externalReference,
  planType
) {
  console.log('Registrando pagamento com:', {
    planType,
    amount
  });

  const queryText = `
    INSERT INTO payments (
      user_email,
      user_cpf,
      mercadopago_id,
      amount,
      status,
      payment_method,
      external_reference,
      plan_type,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    RETURNING *`;

  const values = [
    userEmail,
    userCpf,
    mercadopagoId,
    amount,
    status,
    paymentMethod,
    externalReference,
    planType
  ];

  try {
    const result = await pool.query(queryText, values);
    return result.rows[0];
  } catch (error) {
    console.error('Erro ao registrar pagamento:', {
      errorMessage: error.message,
      stack: error.stack,
      query: queryText,
      values: values
    });
    throw new Error(`Falha no registro: ${error.message}`);
  }
}

async function createUserIfNotExists(client, userData) {
  try {
    const existingUser = await client.query(
      `SELECT * FROM users 
       WHERE email = $1 OR cpf = $2 
       LIMIT 1`,
      [userData.email, userData.cpf]
    );

    if (existingUser.rowCount > 0) {
      return existingUser.rows[0];
    }

    const newUserResult = await client.query(
      `INSERT INTO users (
        email,
        cpf,
        created_at,
        updated_at
      ) VALUES ($1, $2, NOW(), NOW())
      RETURNING *`,
      [userData.email, userData.cpf]
    );

    return newUserResult.rows[0];

  } catch (error) {
    console.error('Erro ao criar usuário:', error.message);
    throw new Error(`Falha na criação: ${error.message}`);
  }
}

async function updatePaymentStatus(pool, paymentInfo) {
  const queryText = `
    UPDATE payments 
    SET 
      status = $1,
      updated_at = NOW(),
      attempts = attempts + 1
    WHERE mercadopago_id = $2 
    RETURNING *`;

  try {
    const result = await pool.query(queryText, [
      paymentInfo.status,
      paymentInfo.id
    ]);

    if (result.rowCount === 0) {
      throw new Error(`Pagamento não encontrado: ${paymentInfo.id}`);
    }

    return result.rows[0];

  } catch (error) {
    console.error('Erro na atualização:', error.message);
    throw new Error(`Falha na atualização: ${error.message}`);
  }
}

module.exports = router;