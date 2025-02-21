const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');

// Configuração do token de acesso e URL base da API
const ACCESS_TOKEN = "TEST-124639488725733-022019-b62d2acb8e137c40629a18b9dc7571df-1254217648";
const BASE_URL = "https://api.mercadopago.com/v1/payments";
const MP_WEBHOOK_SECRET = "9dcee93ad0b999bc005ed723554e8f7cdd7021d036f1f043a39ee966af668dc3";

/**
 * Rota para criar um pagamento
 */
router.post('/create-payment', async (req, res) => {
  try {
    const { paymentMethod, plan, userData } = req.body;

    // Validação básica dos dados recebidos
    if (!paymentMethod || !plan || !userData) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    // Estrutura dos dados do pagamento
    const paymentData = {
      transaction_amount: plan.price,
      description: `Assinatura ${plan.label} - ${plan.period}`,
      payment_method_id: paymentMethod,
      payer: {
        email: userData.email,
        first_name: userData.name.split(' ')[0],
        last_name: userData.name.split(' ')[1] || '',
        identification: {
          type: 'CPF',
          number: userData.cpf.replace(/\D/g, '')
        }
      }
    };

    // Configuração específica para pagamento via Pix
    if (paymentMethod === 'pix') {
      paymentData.payment_method_id = 'pix';
      paymentData.transaction_details = {
        financial_institution: ''
      };
    }

    // Chamada à API do Mercado Pago para criar o pagamento
    const response = await axios.post(BASE_URL, paymentData, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const payment = response.data;

    // Verifica se o pagamento foi rejeitado
    if (payment.status === 'rejected') {
      return res.status(400).json({
        error: 'Pagamento recusado',
        details: payment
      });
    }

    // Resposta com os dados do pagamento criado
    res.json({
      paymentId: payment.id,
      ...(paymentMethod === 'pix' && {
        qrCode: payment.point_of_interaction?.transaction_data?.qr_code,
        qrCodeBase64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
        expires: payment.date_of_expiration
      })
    });

  } catch (error) {
    console.error('Erro no pagamento:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Erro ao processar pagamento',
      details: error.response ? error.response.data : error.message
    });
  }
});

/**
 * Rota para consultar o status de um pagamento
 */
router.get('/payment-status/:id', async (req, res) => {
  try {
    // Chamada à API do Mercado Pago para consultar o status
    const response = await axios.get(`${BASE_URL}/${req.params.id}`, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });

    res.json(response.data);

  } catch (error) {
    console.error('Erro ao verificar pagamento:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Erro ao verificar status',
      details: error.response ? error.response.data : error.message
    });
  }
});

/**
 * Rota para receber notificações via webhook
 */
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-signature'];
    if (!signature) return res.status(401).end();

    // Extrair timestamp e hash do header x-signature
    const [tsPart, v1Part] = signature.split(',');
    const timestamp = tsPart.split('=')[1];
    const receivedHash = v1Part.split('=')[1];

    // Gerar o HMAC-SHA256 esperado para validação
    const rawBody = JSON.stringify(req.body);
    const expectedHash = crypto
      .createHmac('sha256', MP_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    // Validar a assinatura
    if (receivedHash !== expectedHash) {
      console.error('Assinatura inválida');
      return res.status(401).end();
    }

    const paymentId = req.body.data.id;
    // Aqui você pode adicionar lógica para atualizar o status no banco de dados

    res.status(200).end();

  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).end();
  }
});

module.exports = router;