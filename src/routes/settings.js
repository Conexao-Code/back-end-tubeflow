const express = require('express');
const router = express.Router();

// Obter configurações do sistema (única)
router.get('/settings', async (req, res) => {
    try {
        const connection = await req.db.getConnection();

        const [settings] = await connection.query(
            `SELECT api_key, sender_phone, message_template, auto_notify 
             FROM settings 
             LIMIT 1`
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

// Atualizar configurações do sistema (única)
router.post('/settings', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const { apiKey, senderPhone, messageTemplate, autoNotify } = req.body;

        // Primeiro, verifica se já existe uma configuração
        const [existingSettings] = await connection.query(
            `SELECT id FROM settings LIMIT 1`
        );

        if (existingSettings.length === 0) {
            // Se não existe, insere um novo registro
            await connection.query(
                `INSERT INTO settings (id, api_key, sender_phone, message_template, auto_notify)
                 VALUES (1, ?, ?, ?, ?)`,
                [apiKey || '', senderPhone || '', messageTemplate.replace(/\r\n|\r|\n/g, '\\n') || '', autoNotify ? 1 : 0]
            );
        } else {
            // Se já existe, atualiza o registro existente
            await connection.query(
                `UPDATE settings 
                 SET api_key = ?, sender_phone = ?, message_template = ?, auto_notify = ? 
                 WHERE id = 1`,
                [apiKey || '', senderPhone || '', messageTemplate.replace(/\r\n|\r|\n/g, '\\n') || '', autoNotify ? 1 : 0]
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
