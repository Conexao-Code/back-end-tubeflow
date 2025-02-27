const express = require('express');
const router = express.Router();

// Rota GET para obter configurações
router.get('/settings', async (req, res) => {
    let client;
    try {
        const companyId = req.query.companyId;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID é obrigatório'
            });
        }

        client = await req.db.connect();
        
        const result = await client.query(
            `SELECT 
                api_key, 
                sender_phone, 
                message_template, 
                auto_notify,
                created_at,
                updated_at
             FROM settings 
             WHERE company_id = $1
             LIMIT 1`,
            [companyId]
        );

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                data: {
                    api_key: '', 
                    sender_phone: '', 
                    message_template: 'Olá, {name}! Um novo vídeo foi atribuído a você: {titulo}', 
                    auto_notify: false,
                    created_at: null,
                    updated_at: null
                }
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Erro ao buscar configurações:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno no servidor',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// Rota POST para atualizar configurações
router.post('/settings', async (req, res) => {
    let client;
    try {
        const { 
            companyId, 
            apiKey, 
            senderPhone, 
            messageTemplate, 
            autoNotify 
        } = req.body;

        if (!companyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID é obrigatório'
            });
        }

        client = await req.db.connect();
        const processedMessage = messageTemplate
            .replace(/\r\n|\r|\n/g, '\\n')
            .replace(/'/g, "''");

        // Verifica existência
        const checkResult = await client.query(
            `SELECT company_id 
             FROM settings 
             WHERE company_id = $1 
             LIMIT 1`,
            [companyId]
        );

        // Operação de INSERT ou UPDATE
        if (checkResult.rows.length === 0) {
            await client.query(
                `INSERT INTO settings (
                    company_id,
                    api_key,
                    sender_phone,
                    message_template,
                    auto_notify
                ) VALUES ($1, $2, $3, $4, $5)`,
                [
                    companyId,
                    apiKey || null,
                    senderPhone || null,
                    processedMessage || null,
                    Boolean(autoNotify)
                ]
            );
        } else {
            await client.query(
                `UPDATE settings 
                 SET api_key = $1,
                     sender_phone = $2,
                     message_template = $3,
                     auto_notify = $4,
                     updated_at = NOW()
                 WHERE company_id = $5`,
                [
                    apiKey || null,
                    senderPhone || null,
                    processedMessage || null,
                    Boolean(autoNotify),
                    companyId
                ]
            );
        }

        res.json({
            success: true,
            message: 'Configurações atualizadas com sucesso'
        });

    } catch (error) {
        console.error('Erro ao atualizar configurações:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno no servidor',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;