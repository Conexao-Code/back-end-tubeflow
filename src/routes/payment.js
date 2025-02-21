// paymentRoutes.js
const express = require('express');
const router = express.Router();
const mercadopago = require('mercadopago');
const { v4: uuidv4 } = require('uuid');

// Configuração do Mercado Pago
mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

// Rota principal de pagamento
router.post('/create-payment', async (req, res) => {
  try {
    const { paymentMethod, plan, userData } = req.body;
    
    // Validação de segurança
    if (!validatePaymentData(req.body)) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

    // Verificar preço contra valores esperados
    const validPrices = { monthly: 97.00, annual: 997.00 };
    if (!Object.values(validPrices).includes(plan.price)) {
      return res.status(400).json({ error: 'Valor inválido' });
    }

    if (paymentMethod === 'pix') {
      return handlePixPayment(res, plan, userData);
    }

    // Lógica para cartão de crédito (existente no frontend)
    return res.json({ success: true });

  } catch (error) {
    console.error('Erro no processamento de pagamento:', error);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// Webhook para notificações do Mercado Pago
router.post('/pix/webhook', async (req, res) => {
  try {
    const { id, type } = req.query;
    
    // Verificação de segurança
    if (!verifyWebhookSignature(req)) {
      return res.status(401).send('Invalid signature');
    }

    // Buscar detalhes do pagamento
    const paymentInfo = await mercadopago.payment.get(id);
    const { status, payment_method_id } = paymentInfo.body;

    // Atualizar status no banco de dados
    await updatePaymentStatus(id, status);

    if (status === 'approved') {
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
    }
  };

  try {
    const payment = await mercadopago.payment.create(paymentData);
    const { qr_code, qr_code_base64, date_of_expiration } = payment.body.point_of_interaction.transaction_data;

    // Registrar pagamento no banco
    const paymentId = await registerPayment({
      method: 'pix',
      amount: plan.price,
      status: 'pending',
      mercadopagoId: payment.body.id,
      expiration: date_of_expiration,
      qrCode: qr_code,
      qrCodeBase64: qr_code_base64,
      userData
    });

    res.json({
      paymentId,
      qrCode: qr_code,
      qrCodeBase64: qr_code_base64,
      expires: date_of_expiration
    });

  } catch (error) {
    console.error('Erro no Mercado Pago:', error);
    res.status(500).json({ error: 'Erro ao gerar PIX' });
  }
}

// Validação de dados
function validatePaymentData(data) {
  // Implementar validações específicas
  const cpfRegex = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
  return (
    data.plan &&
    data.userData &&
    cpfRegex.test(data.userData.cpf) &&
    data.userData.email.includes('@')
  );
}

module.exports = router;