const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('../config');
const bcrypt = require('bcrypt'); 
const jwt = require('jsonwebtoken'); 

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

    const dbPayment = await req.db.query(
      `SELECT plan_type, amount, user_email, company_id, subscription_updated 
       FROM payments 
       WHERE mercadopago_id = $1`,
      [payment.id]
    );

    const paymentData = dbPayment.rows[0] || {};
    const userEmail = paymentData.user_email;

    // Verificação de existência do usuário
    let userExists = false;
    if (userEmail) {
      const userCheck = await req.db.query(
        'SELECT id FROM users WHERE email = $1',
        [userEmail]
      );
      userExists = userCheck.rowCount > 0;
    }

    // Lógica de atualização de assinatura
    if (payment.status === 'approved' && paymentData.company_id && !paymentData.subscription_updated) {
      try {
        // Mapeamento de intervalos
        const planIntervalMap = {
          monthly: '1 month',
          quarterly: '3 months',
          annual: '1 year'
        };

        // Determinar intervalo do plano
        const rawPlanType = paymentData.plan_type?.toLowerCase() || 'monthly';
        const planType = Object.keys(planIntervalMap).includes(rawPlanType) 
          ? rawPlanType 
          : 'monthly';
        
        const interval = planIntervalMap[planType];

        // Atualizar assinatura com transação
        await req.db.query('BEGIN');
        
        const companyUpdate = await req.db.query(
          `UPDATE companies
           SET 
             subscription_end = CASE 
               WHEN subscription_end IS NULL THEN NOW() + $1::interval
               WHEN subscription_end < NOW() THEN NOW() + $1::interval
               ELSE subscription_end + $1::interval
             END,
             subscription_start = CASE 
               WHEN subscription_end < NOW() THEN NOW()
               ELSE subscription_start
             END
           WHERE id = $2
           RETURNING *`,
          [interval, paymentData.company_id]
        );

        // Marcar pagamento como processado
        await req.db.query(
          `UPDATE payments 
           SET subscription_updated = TRUE 
           WHERE mercadopago_id = $1`,
          [payment.id]
        );

        await req.db.query('COMMIT');
        
        console.log(`Assinatura ${planType} atualizada para empresa ${paymentData.company_id}`);

      } catch (updateError) {
        await req.db.query('ROLLBACK');
        console.error('Erro na transação de assinatura:', {
          error: updateError.message,
          paymentId: payment.id,
          companyId: paymentData.company_id
        });
      }
    }

    const responseData = {
      payment_id: payment.id,
      status: payment.status,
      last_updated: payment.updated_at,
      amount: paymentData.amount || payment.amount,
      plan_type: paymentData.plan_type || 'unknown',
      user_exists: userExists,
      company_id: paymentData.company_id,
      subscription_updated: paymentData.subscription_updated,
      subscription_action: payment.status === 'approved' ? 'processed' : 'none'
    };

    res.json(responseData);

  } catch (error) {
    console.error('Erro completo na verificação de status:', {
      message: error.message,
      stack: error.stack,
      params: req.params
    });
    
    res.status(500).json({
      error: 'Falha na verificação do pagamento',
      technical_details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.post('/create-account', async (req, res) => {
  const { email, companyName, password, paymentId } = req.body;
  const client = await req.db.connect();

  try {
    await client.query('BEGIN');

    // Validação completa dos campos
    const requiredFields = ['email', 'companyName', 'password', 'paymentId'];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    
    if (missingFields.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Dados incompletos',
        missing_fields: missingFields,
        example_correction: {
          email: "usuario@empresa.com",
          companyName: "Empresa Exemplo Ltda",
          password: "SenhaSegura@123",
          paymentId: "PAY-123456789"
        }
      });
    }

    // Verificação de empresa existente
    const companyCheck = await client.query(
      'SELECT id FROM companies WHERE name = $1',
      [companyName]
    );

    if (companyCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Empresa já registrada',
        suggested_actions: [
          "Utilize um nome comercial diferente",
          "Entre em contato para fusão de contas"
        ],
        contact_support: "suporte@tubeflow.com"
      });
    }

    // Obter detalhes do pagamento
    const paymentDetails = await client.query(
      `SELECT plan_type, amount 
       FROM payments 
       WHERE mercadopago_id = $1 
       FOR UPDATE`,
      [paymentId]
    );

    if (paymentDetails.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'Pagamento não localizado',
        actions: [
          "Verifique o ID do pagamento",
          "Aguarde 15 minutos para processamento"
        ]
      });
    }

    // Configurar intervalo inicial
    const planData = paymentDetails.rows[0];
    const intervalMap = {
      monthly: '1 month',
      quarterly: '3 months',
      annual: '1 year'
    };
    
    const planType = planData.plan_type?.toLowerCase() in intervalMap 
      ? planData.plan_type.toLowerCase() 
      : 'monthly';
    
    const subscriptionInterval = intervalMap[planType];

    // Criar subdomínio único
    const cleanCompanyName = companyName
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remover acentos
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 20);
    
    const subdomainSuffix = Math.random().toString(36).slice(2, 6);
    const finalSubdomain = `${cleanCompanyName}-${subdomainSuffix}`;

    // Inserir empresa com intervalo correto
    const companyResult = await client.query(
      `INSERT INTO companies (
        name, 
        subdomain, 
        active, 
        subscription_start, 
        subscription_end
      ) VALUES ($1, $2, TRUE, NOW(), NOW() + $3::interval)
      RETURNING id, subdomain, subscription_start, subscription_end`,
      [companyName, finalSubdomain, subscriptionInterval]
    );

    const companyData = companyResult.rows[0];
    const companyId = companyData.id;

    // Verificar usuário existente na nova empresa
    const userCheck = await client.query(
      `SELECT id FROM users 
       WHERE email = $1 AND company_id = $2`,
      [email, companyId]
    );

    if (userCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Colaborador já registrado',
        resolution_steps: [
          "Solicite acesso ao administrador da empresa",
          "Utilize a recuperação de senha"
        ]
      });
    }

    // Criptografia de senha
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Criar usuário admin
    const userResult = await client.query(
      `INSERT INTO users (
        company_id, 
        name, 
        email, 
        password, 
        role,
        is_active
      ) VALUES ($1, $2, $3, $4, 'admin', TRUE)
      RETURNING id, created_at`,
      [companyId, 'Administrador Principal', email, hashedPassword]
    );

    // Vincular pagamento à empresa
    const paymentUpdate = await client.query(
      `UPDATE payments
       SET 
         company_id = $1,
         subscription_updated = TRUE,
         updated_at = NOW()
       WHERE mercadopago_id = $2
       RETURNING id`,
      [companyId, paymentId]
    );

    if (paymentUpdate.rowCount === 0) {
      throw new Error(`Falha ao vincular pagamento ${paymentId} à empresa ${companyId}`);
    }

    await client.query('COMMIT');

    // Gerar token JWT seguro
    const tokenPayload = {
      uid: userResult.rows[0].id,
      cid: companyId,
      rol: 'admin',
      sub: finalSubdomain,
      plan: planType
    };

    const token = jwt.sign(
      tokenPayload,
      config.JWT_SECRET,
      {
        expiresIn: '7d',
        issuer: 'api.tubeflow',
        audience: 'client.tubeflow',
        algorithm: 'HS256'
      }
    );

    // Montar resposta final
    res.status(201).json({
      success: true,
      authentication: {
        token: {
          value: token,
          type: 'Bearer',
          expires_in: '7d'
        },
        renewal_info: {
          next_renewal: companyData.subscription_end,
          plan_type: planType
        }
      },
      company: {
        id: companyId,
        name: companyName,
        subdomain: companyData.subdomain,
        subscription_status: {
          start: companyData.subscription_start,
          end: companyData.subscription_end,
          active: true
        }
      },
      user: {
        id: userResult.rows[0].id,
        email: email,
        role: 'admin',
        initial_setup: true
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    
    const errorId = uuidv4();
    console.error(`Erro [${errorId}] em create-account:`, {
      message: error.message,
      stack: error.stack,
      body: req.body,
      time: new Date().toISOString()
    });

    const response = {
      error: 'Falha no processo de criação',
      reference_id: errorId,
      user_action: [
        "Verifique os dados fornecidos",
        "Tente novamente em 5 minutos"
      ]
    };

    if (error.code === '23505') {
      response.error = 'Conflito de dados únicos';
      response.details = error.constraint.includes('email') 
        ? 'E-mail já registrado' 
        : 'Identificador único duplicado';
    }

    res.status(error.statusCode || 500).json(response);
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