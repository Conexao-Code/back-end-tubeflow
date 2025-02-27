const express = require('express');
const router = express.Router();

// Obter configurações do sistema por empresa
router.get('/settings', async (req, res) => {
    let client;
    try {
        const companyId = req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        // Obter cliente do pool PostgreSQL
        client = await req.db.connect();
        
        const result = await client.query(
            `SELECT api_key, sender_phone, message_template, auto_notify 
             FROM settings 
             WHERE company_id = $1
             LIMIT 1`,
            [companyId]
        );

        if (result.rows.length === 0) {
            return res.json({ 
                api_key: '', 
                sender_phone: '', 
                message_template: 'Olá, {name}! Um novo vídeo foi atribuído a você: {titulo}', 
                auto_notify: false 
            });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Erro ao buscar configurações:', error);
        res.status(500).json({ message: 'Erro ao buscar configurações.' });
    } finally {
        if (client) client.release();
    }
});

// Atualizar configurações por empresa
router.post('/settings', async (req, res) => {
    let client;
    try {
        const { companyId, apiKey, senderPhone, messageTemplate, autoNotify } = req.body;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        // Obter cliente do pool PostgreSQL
        client = await req.db.connect();

        // Verifica configurações existentes
        const checkResult = await client.query(
            `SELECT company_id FROM settings WHERE company_id = $1 LIMIT 1`,
            [companyId]
        );

        if (checkResult.rows.length === 0) {
            // Inserir nova configuração
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
                    apiKey || '', 
                    senderPhone || '', 
                    messageTemplate.replace(/\r\n|\r|\n/g, '\\n') || '', 
                    autoNotify
                ]
            );
        } else {
            // Atualizar configuração existente
            await client.query(
                `UPDATE settings 
                 SET api_key = $1, 
                     sender_phone = $2, 
                     message_template = $3, 
                     auto_notify = $4 
                 WHERE company_id = $5`,
                [
                    apiKey || '', 
                    senderPhone || '', 
                    messageTemplate.replace(/\r\n|\r|\n/g, '\\n') || '', 
                    autoNotify,
                    companyId
                ]
            );
        }

        res.json({ message: 'Configurações atualizadas com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar configurações:', error);
        res.status(500).json({ message: 'Erro ao atualizar configurações.' });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;