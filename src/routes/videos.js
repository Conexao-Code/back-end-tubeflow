const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const axios = require('axios');
const config = require('../config');

// Configuração do pool PostgreSQL
const pool = new Pool(config.dbConfig.postgres);

// Middleware para injetar o pool de conexões
router.use((req, res, next) => {
    req.db = pool;
    next();
});

// Helper Functions
const normalizePhoneNumber = (phone) => {
    const cleaned = (phone || '').replace(/\D/g, '');
    return cleaned.length >= 12 ? cleaned : `55${cleaned}`;
};

const validateFreelancerExists = async (client, freelancerId, companyId) => {
    const result = await client.query(
        'SELECT id FROM freelancers WHERE id = $1 AND company_id = $2',
        [freelancerId, companyId]
    );
    return result.rowCount > 0;
};

// Rotas de Vídeos
router.get('/videos', async (req, res) => {
    let client;
    try {
        const { companyId, freelancerId, channelId, status, searchTerm } = req.query;
        const userId = req.user?.id;
        const isFreelancer = req.user?.role === 'freelancer';

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        let queryParams = [companyId];
        let query = `
      SELECT 
        v.*,
        c.name AS channel_name,
        fw.name AS script_writer_name,
        fn.name AS narrator_name,
        fe.name AS editor_name,
        ft.name AS thumb_maker_name
      FROM videos v
      LEFT JOIN channels c ON v.channel_id = c.id AND c.company_id = $1
      LEFT JOIN freelancers fw ON v.script_writer_id = fw.id AND fw.company_id = $1
      LEFT JOIN freelancers fn ON v.narrator_id = fn.id AND fn.company_id = $1
      LEFT JOIN freelancers fe ON v.editor_id = fe.id AND fe.company_id = $1
      LEFT JOIN freelancers ft ON v.thumb_maker_id = ft.id AND ft.company_id = $1
      WHERE v.company_id = $1
    `;

        if (isFreelancer) {
            query += ' AND v.freelancer_id = $2';
            queryParams.push(userId);
        }

        if (freelancerId) {
            query += ' AND v.freelancer_id = $' + (queryParams.length + 1);
            queryParams.push(freelancerId);
        }

        if (channelId) {
            query += ' AND v.channel_id = $' + (queryParams.length + 1);
            queryParams.push(channelId);
        }

        if (status) {
            query += ' AND v.status = $' + (queryParams.length + 1);
            queryParams.push(status);
        }

        if (searchTerm) {
            query += ' AND (v.title ILIKE $' + (queryParams.length + 1) +
                ' OR c.name ILIKE $' + (queryParams.length + 2) + ')';
            queryParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        const result = await client.query(query, queryParams);
        res.json(result.rows);
    } catch (error) {
        console.error('Erro ao buscar vídeos:', error);
        res.status(500).json({
            message: 'Erro ao buscar vídeos',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.post('/videos', async (req, res) => {
    let client;
    try {
        const { companyId, title, channelId, status, observations, youtubeUrl,
                scriptWriterId, narratorId, editorId, thumbMakerId, userId } = req.body;

        // Validação de campos obrigatórios
        if (!companyId || !title || !channelId || !status || !scriptWriterId || 
            !narratorId || !editorId || !thumbMakerId || !userId) {
            return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser preenchidos.' });
        }

        client = await req.db.connect();

        // Validação de freelancers
        const validations = await Promise.all([
            validateFreelancerExists(client, scriptWriterId, companyId),
            validateFreelancerExists(client, narratorId, companyId),
            validateFreelancerExists(client, editorId, companyId),
            validateFreelancerExists(client, thumbMakerId, companyId)
        ]);

        if (validations.some(valid => !valid)) {
            return res.status(400).json({ message: 'Um ou mais IDs de freelancers são inválidos.' });
        }

        // Inserção do vídeo
        const videoResult = await client.query(
            `INSERT INTO videos (
                title, channel_id, status, observations, youtube_url,
                script_writer_id, narrator_id, editor_id, thumb_maker_id,
                company_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
            RETURNING id`,
            [
                title, channelId, status, observations, youtubeUrl,
                scriptWriterId, narratorId, editorId, thumbMakerId, companyId
            ]
        );

        const videoId = videoResult.rows[0].id;

        res.status(201).json({ 
            id: videoId, 
            message: 'Vídeo criado com sucesso.',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Erro ao criar vídeo:', error);
        res.status(500).json({ 
            message: 'Erro ao criar vídeo.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.delete('/videos/:id', async (req, res) => {
    let client;
    try {
        const { id } = req.params;
        const { companyId } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();

        // Primeiro deleta os logs relacionados
        await client.query(
            'DELETE FROM video_logs WHERE video_id = $1 AND company_id = $2',
            [id, companyId]
        );

        // Depois deleta o vídeo
        const result = await client.query(
            'DELETE FROM videos WHERE id = $1 AND company_id = $2 RETURNING *',
            [id, companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Vídeo não encontrado' });
        }

        res.json({ 
            message: 'Vídeo excluído com sucesso',
            deletedVideo: result.rows[0]
        });
    } catch (error) {
        console.error('Erro ao excluir vídeo:', error);
        res.status(500).json({
            message: 'Erro ao excluir vídeo',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.put('/videos/:id', async (req, res) => {
    let client;
    try {
        const { id } = req.params;
        const { companyId, title, channelId, status, observations, youtubeUrl,
            scriptWriterId, narratorId, editorId, thumbMakerId, userId } = req.body;

        if (!companyId || !title || !channelId || !status || !scriptWriterId ||
            !narratorId || !editorId || !thumbMakerId || !userId) {
            return res.status(400).json({ message: 'Campos obrigatórios faltando' });
        }

        client = await req.db.connect();

        // Verificar existência do vídeo
        const videoResult = await client.query(
            'SELECT * FROM videos WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );
        if (videoResult.rowCount === 0) {
            return res.status(404).json({ message: 'Vídeo não encontrado' });
        }

        // Validar freelancers
        const validations = await Promise.all([
            validateFreelancerExists(client, scriptWriterId, companyId),
            validateFreelancerExists(client, narratorId, companyId),
            validateFreelancerExists(client, editorId, companyId),
            validateFreelancerExists(client, thumbMakerId, companyId)
        ]);

        if (validations.some(valid => !valid)) {
            return res.status(400).json({ message: 'IDs de freelancers inválidos' });
        }

        // Atualizar vídeo
        await client.query(
            `UPDATE videos SET
        title = $1, channel_id = $2, status = $3, observations = $4,
        youtube_url = $5, script_writer_id = $6, narrator_id = $7,
        editor_id = $8, thumb_maker_id = $9, updated_at = NOW()
      WHERE id = $10 AND company_id = $11`,
            [title, channelId, status, observations, youtubeUrl,
                scriptWriterId, narratorId, editorId, thumbMakerId, id, companyId]
        );

        res.json({ message: 'Vídeo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar vídeo:', error);
        res.status(500).json({
            message: 'Erro ao atualizar vídeo',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.put('/videos/:id/status', async (req, res) => {
    let client;
    try {
        const { id } = req.params;
        const { companyId, status, userId, isUser, sendMessage } = req.body;
        const nextStatusMap = {
            'Roteiro_Concluído': 'Narração_Solicitada',
            'Narração_Concluída': 'Edição_Solicitada',
            'Edição_Concluída': 'Thumbnail_Solicitada',
            'Thumbnail_Concluída': null,
        };

        if (!companyId || !status || !userId) {
            return res.status(400).json({
                message: 'Parâmetros obrigatórios: companyId, status, userId'
            });
        }

        client = await pool.connect();

        // Encontrar um administrador válido para a empresa
        const adminCheck = await client.query(
            `SELECT id FROM users 
            WHERE company_id = $1 
            AND role = 'admin' 
            LIMIT 1`,
            [companyId]
        );

        if (!adminCheck.rows[0]) {
            return res.status(400).json({
                code: 'MISSING_ADMIN',
                message: 'Nenhum administrador cadastrado para esta empresa',
                solution: 'Crie um usuário com role=admin antes de continuar'
            });
        }
        const adminUserId = adminCheck.rows[0].id;

        let validUserId;
        let freelancerId = null;

        if (isUser) {
            // Validação para usuários internos
            const userResult = await client.query(
                `SELECT id FROM users 
                WHERE id = $1 
                AND company_id = $2`,
                [userId, companyId]
            );
            
            if (!userResult.rows[0]) {
                return res.status(404).json({
                    code: 'USER_NOT_FOUND',
                    message: 'Usuário interno não encontrado'
                });
            }
            validUserId = userId;
        } else {
            // Validação para freelancers
            const freelancerResult = await client.query(
                `SELECT id FROM freelancers 
                WHERE id = $1 
                AND company_id = $2`,
                [userId, companyId]
            );
            
            if (!freelancerResult.rows[0]) {
                return res.status(404).json({
                    code: 'FREELANCER_NOT_FOUND',
                    message: 'Freelancer não encontrado'
                });
            }
            validUserId = adminUserId; // Usa o ID do admin
            freelancerId = userId;    // ID real do freelancer
        }

        // Buscar dados do vídeo
        const videoResult = await client.query(
            `SELECT id, title, status, updated_at, 
             script_writer_id, narrator_id, editor_id, thumb_maker_id
             FROM videos 
             WHERE id = $1 AND company_id = $2`,
            [id, companyId]
        );

        if (videoResult.rowCount === 0) {
            return res.status(404).json({
                code: 'VIDEO_NOT_FOUND',
                message: 'Vídeo não encontrado'
            });
        }

        const video = videoResult.rows[0];
        const currentStatus = video.status;

        // Atualizar status principal
        const updateResult = await client.query(
            `UPDATE videos 
            SET status = $1, updated_at = NOW() 
            WHERE id = $2 AND company_id = $3 
            RETURNING *`,
            [status, id, companyId]
        );

        const updatedVideo = updateResult.rows[0];

        // Calcular duração
        let duration = 0;
        if (currentStatus.endsWith('_Em_Andamento') && status.endsWith('_Concluída')) {
            const startTime = new Date(video.updated_at);
            const endTime = new Date(updatedVideo.updated_at);
            duration = Math.floor((endTime - startTime) / 1000);
        }

        // Registrar log com IDs corretos
        await client.query(
            `INSERT INTO video_logs (
                video_id, user_id, freelancer_id,
                action, from_status, to_status,
                created_at, duration, is_user, company_id
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)`,
            [
                id,
                validUserId,
                freelancerId,
                'Alteração de Status',
                currentStatus,
                status,
                duration,
                isUser,
                companyId
            ]
        );

        // Atualização automática do próximo status
        const nextStatus = nextStatusMap[status];
        if (nextStatus) {
            await client.query(
                `UPDATE videos 
                SET status = $1, updated_at = NOW() 
                WHERE id = $2 AND company_id = $3`,
                [nextStatus, id, companyId]
            );
        }

        // Sistema de notificação
        if (sendMessage) {
            const notificationMap = {
                'Roteiro_Solicitado': { column: 'script_writer_id', task: 'roteiro' },
                'Narração_Solicitada': { column: 'narrator_id', task: 'narração' },
                'Edição_Solicitada': { column: 'editor_id', task: 'edição' },
                'Thumbnail_Solicitada': { column: 'thumb_maker_id', task: 'thumbnail' }
            };

            const config = notificationMap[status];
            if (config && video[config.column]) {
                const freelancerResult = await client.query(
                    `SELECT name, phone 
                    FROM freelancers 
                    WHERE id = $1 
                    AND company_id = $2`,
                    [video[config.column], companyId]
                );

                if (freelancerResult.rows[0]?.phone) {
                    await sendWhatsAppMessage({
                        companyId: companyId,
                        phone: freelancerResult.rows[0].phone,
                        videoTitle: video.title,
                        freelancerName: freelancerResult.rows[0].name,
                        task: config.task
                    });
                }
            }
        }

        res.json({
            success: true,
            data: {
                video: {
                    id: updatedVideo.id,
                    previousStatus: currentStatus,
                    newStatus: status,
                    nextStatus: nextStatus || 'Processo Finalizado',
                    duration: `${duration} segundos`
                },
                logDetails: {
                    recordedBy: isUser ? 'Usuário Interno' : 'Administrador',
                    userIdUsed: validUserId,
                    freelancerId: freelancerId
                }
            }
        });

    } catch (error) {
        console.error('Erro na atualização:', {
            error: error.message,
            params: req.params,
            body: req.body
        });

        res.status(500).json({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Erro no processamento da solicitação',
            details: process.env.NODE_ENV === 'development' ? {
                error: error.message,
                stack: error.stack
            } : undefined
        });

    } finally {
        if (client) client.release();
    }
});

// Rotas de Comentários
router.post('/videos/:id/comments', async (req, res) => {
    let client;
    try {
        const { id } = req.params;
        const { companyId, text, userId, userType } = req.body;

        if (!companyId || !text || !userId || !userType) {
            return res.status(400).json({ message: 'Parâmetros obrigatórios faltando' });
        }

        client = await req.db.connect();

        // Validar usuário
        const userTable = userType === 'freelancer' ? 'freelancers' : 'users';
        const userResult = await client.query(
            `SELECT id, name, role FROM ${userTable} WHERE id = $1 AND company_id = $2`,
            [userId, companyId]
        );
        if (userResult.rowCount === 0) {
            return res.status(400).json({ message: 'Usuário não encontrado' });
        }

        const user = userResult.rows[0];

        // Inserir comentário
        await client.query(
            `INSERT INTO comments (
        video_id, text, user_type, user_id, freelancer_id, 
        company_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                id,
                text,
                userType,
                userType === 'user' ? userId : null,
                userType === 'freelancer' ? userId : null,
                companyId
            ]
        );

        res.status(201).json({
            message: 'Comentário adicionado',
            comment: {
                text,
                userName: user.name,
                userRole: user.role
            }
        });
    } catch (error) {
        console.error('Erro ao adicionar comentário:', error);
        res.status(500).json({
            message: 'Erro ao adicionar comentário',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/videos/:id/comments', async (req, res) => {
    let client;
    try {
        const { id } = req.params;
        const { companyId } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();

        const result = await client.query(
            `SELECT 
        c.text,
        c.created_at,
        c.user_type,
        COALESCE(f.name, u.name) AS user_name,
        COALESCE(f.role, 'admin') AS user_role
      FROM comments c
      LEFT JOIN freelancers f ON c.freelancer_id = f.id AND c.user_type = 'freelancer'
      LEFT JOIN users u ON c.user_id = u.id AND c.user_type = 'user'
      WHERE c.video_id = $1 AND c.company_id = $2
      ORDER BY c.created_at DESC`,
            [id, companyId]
        );

        res.json({
            comments: result.rows.map(comment => ({
                text: comment.text,
                createdAt: comment.created_at,
                userName: comment.user_name,
                userRole: comment.user_role
            }))
        });
    } catch (error) {
        console.error('Erro ao buscar comentários:', error);
        res.status(500).json({
            message: 'Erro ao buscar comentários',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

// Rotas de Canais
// Rotas de Canais
router.get('/channels4', async (req, res) => {
    let client;
    try {
        const { companyId } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        const result = await client.query(
            'SELECT id, name FROM channels WHERE company_id = $1',
            [companyId]
        );

        // Corrigido para enviar no formato esperado pelo front-end
        res.json({
            channels: result.rows
        });
    } catch (error) {
        console.error('Erro ao buscar canais:', error);
        res.status(500).json({
            message: 'Erro ao buscar canais',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

// Rotas de Freelancers
router.get('/freelancers4', async (req, res) => {
    let client;
    try {
        const { companyId } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        const result = await client.query(
            'SELECT id, name, role FROM freelancers WHERE company_id = $1',
            [companyId]
        );

        // Corrigido para enviar no formato esperado pelo front-end
        res.json({
            freelancers: result.rows
        });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({
            message: 'Erro ao buscar freelancers',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

// Status de Vídeo
router.get('/video-status', (req, res) => {
    const statuses = [
        'Pending',
        'Script_Requested',
        'Script_In_Progress',
        'Script_Completed',
        'Narration_Requested',
        'Narration_In_Progress',
        'Narration_Completed',
        'Editing_Requested',
        'Editing_In_Progress',
        'Editing_Completed',
        'Thumbnail_Requested',
        'Thumbnail_In_Progress',
        'Thumbnail_Completed',
        'Published',
        'Cancelled',
    ];
    res.json(statuses);
});

// Função de Envio de WhatsApp
async function sendWhatsAppMessage(client, companyId, phone, videoTitle, freelancerName) {
    try {
        const settingsResult = await client.query(
            `SELECT api_key, sender_phone, message_template 
       FROM settings WHERE company_id = $1`,
            [companyId]
        );

        if (settingsResult.rowCount === 0 ||
            !settingsResult.rows[0].api_key ||
            !settingsResult.rows[0].sender_phone) {
            return;
        }

        const settings = settingsResult.rows[0];
        const formattedPhone = normalizePhoneNumber(phone);
        const messageBody = (settings.message_template || 'Olá, {name}! Um novo vídeo foi atribuído a você: {titulo}')
            .replace(/{name}/g, freelancerName)
            .replace(/{titulo}/g, videoTitle);

        const payload = {
            apikey: settings.api_key,
            phone_number: settings.sender_phone,
            contact_phone_number: formattedPhone,
            message_type: 'text',
            message_body: messageBody.trim(),
            check_status: 0,
        };

        await axios.post('https://app.whatsgw.com.br/api/WhatsGw/Send', payload);
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error.message);
    }
}

module.exports = router;