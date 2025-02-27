const express = require('express');
const router = express.Router();

// Obter configurações do sistema por empresa
router.get('/settings', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const companyId = req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        const [settings] = await connection.query(
            `SELECT api_key, sender_phone, message_template, auto_notify 
             FROM settings 
             WHERE company_id = ?
             LIMIT 1`,
            [companyId]
        );

        connection.release();

        if (settings.length === 0) {
            return res.json({ 
                api_key: '', 
                sender_phone: '', 
                message_template: 'Olá, {name}! Um novo vídeo foi atribuído a você: {titulo}', 
                auto_notify: false 
            });
        }

        res.json(settings[0]);
    } catch (error) {
        console.error('Erro ao buscar configurações:', error);
        res.status(500).json({ message: 'Erro ao buscar configurações.' });
    }
});

// Atualizar configurações por empresa
router.post('/settings', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const { companyId, apiKey, senderPhone, messageTemplate, autoNotify } = req.body;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        // Verifica configurações existentes
        const [existingSettings] = await connection.query(
            `SELECT id FROM settings WHERE company_id = ? LIMIT 1`,
            [companyId]
        );

        if (existingSettings.length === 0) {
            // Inserir nova configuração
            await connection.query(
                `INSERT INTO settings (
                    company_id, 
                    api_key, 
                    sender_phone, 
                    message_template, 
                    auto_notify
                ) VALUES (?, ?, ?, ?, ?)`,
                [
                    companyId,
                    apiKey || '', 
                    senderPhone || '', 
                    messageTemplate.replace(/\r\n|\r|\n/g, '\\n') || '', 
                    autoNotify ? 1 : 0
                ]
            );
        } else {
            // Atualizar configuração existente
            await connection.query(
                `UPDATE settings 
                 SET api_key = ?, 
                     sender_phone = ?, 
                     message_template = ?, 
                     auto_notify = ? 
                 WHERE company_id = ?`,
                [
                    apiKey || '', 
                    senderPhone || '', 
                    messageTemplate.replace(/\r\n|\r|\n/g, '\\n') || '', 
                    autoNotify ? 1 : 0,
                    companyId
                ]
            );
        }

        connection.release();
        res.json({ message: 'Configurações atualizadas com sucesso.' });

    } catch (error) {
        console.error('Erro ao atualizar configurações:', error);
        res.status(500).json({ message: 'Erro ao atualizar configurações.' });
    }
});

module.exports = router;