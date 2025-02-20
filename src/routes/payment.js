const express = require('express');
const router = express.Router();
const mercadopago = require('mercadopago');

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

router.post('/create-payment', async (req, res) => {
  try {
    const { paymentMethod, plan, userData } = req.body;
    
    // Validação básica
    if (!paymentMethod || !plan || !userData) {
      return res.status(400).json({ error: 'Dados inválidos' });
    }

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

    // Configurações específicas para PIX
    if (paymentMethod === 'pix') {
      paymentData.payment_method_id = 'pix';
      paymentData.transaction_details = {
        financial_institution: ''
      };
    }

    const response = await mercadopago.payment.create(paymentData);
    
    // Tratar resposta do Mercado Pago
    if (response.body.status === 'rejected') {
      return res.status(400).json({ 
        error: 'Pagamento recusado',
        details: response.body
      });
    }

    res.json({
      paymentId: response.body.id,
      ...(paymentMethod === 'pix' && {
        qrCode: response.body.point_of_interaction.transaction_data.qr_code,
        qrCodeBase64: response.body.point_of_interaction.transaction_data.qr_code_base64,
        expires: response.body.date_of_expiration
      })
    });

  } catch (error) {
    console.error('Erro no pagamento:', error);
    res.status(500).json({ 
      error: 'Erro ao processar pagamento',
      details: error.message 
    });
  }
});

// Rota para verificar status do pagamento
router.get('/payment-status/:id', async (req, res) => {
  try {
    const payment = await mercadopago.payment.get(req.params.id);
    res.json(payment.body);
  } catch (error) {
    console.error('Erro ao verificar pagamento:', error);
    res.status(500).json({ error: 'Erro ao verificar status' });
  }
});

router.post('/webhook', async (req, res) => {
    try {
      const signature = req.headers['x-signature'];
      if (!signature) return res.status(401).end();
      
      // Validar assinatura
      const isValid = mercadopago.payment.validateWebhook(
        signature,
        process.env.MP_WEBHOOK_SECRET
      );
  
      if (!isValid) return res.status(401).end();
  
      const paymentId = req.body.data.id;
      // Atualizar status no banco de dados
      
      res.status(200).end();
    } catch (error) {
      console.error('Erro no webhook:', error);
      res.status(500).end();
    }
  });

module.exports = router;