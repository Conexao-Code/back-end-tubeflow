const express = require('express');
const router = express.Router();

router.get('/videos', async (req, res) => {
    const { freelancerId, channelId, status, searchTerm } = req.query;
    const userId = req.user?.id;
    const isFreelancer = req.user?.role === 'freelancer';

    try {
        const connection = await req.db.getConnection();

        let query = `
            SELECT 
                videos.*,
                channels.name AS channel_name,
                fw.name AS script_writer_name,
                fn.name AS narrator_name,
                fe.name AS editor_name,
                ft.name AS thumb_maker_name
            FROM 
                videos
            LEFT JOIN 
                channels ON videos.channel_id = channels.id
            LEFT JOIN 
                freelancers fw ON videos.script_writer_id = fw.id
            LEFT JOIN 
                freelancers fn ON videos.narrator_id = fn.id
            LEFT JOIN 
                freelancers fe ON videos.editor_id = fe.id
            LEFT JOIN 
                freelancers ft ON videos.thumb_maker_id = ft.id
            WHERE 
                1=1
        `;
        const params = [];

        if (isFreelancer) {
            query += ' AND videos.freelancer_id = ?';
            params.push(userId);
        }

        if (freelancerId) {
            query += ' AND videos.freelancer_id = ?';
            params.push(freelancerId);
        }

        if (channelId) {
            query += ' AND videos.channel_id = ?';
            params.push(channelId);
        }

        if (status) {
            query += ' AND videos.status = ?';
            params.push(status);
        }

        if (searchTerm) {
            query += ' AND (videos.title LIKE ? OR channels.name LIKE ?)';
            params.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        const [rows] = await connection.query(query, params);
        connection.release();

        res.json(rows);
    } catch (error) {
        console.error('Erro ao buscar vídeos:', error);
        res.status(500).json({ message: 'Erro ao buscar vídeos.' });
    }
});

const axios = require('axios');

const formatPhoneNumber = (phone) => {
    const cleaned = phone.replace(/[^\d]/g, '');
    return `55${cleaned}`;
};

const normalizePhoneNumber = (phone) => {
    if (!phone) return '';

    const cleanedPhone = phone.replace(/\D/g, '');

    if (cleanedPhone.length >= 12) return cleanedPhone;

    return `55${cleanedPhone}`;
};

const sendWhatsAppMessage = async (db, phone, videoTitle, freelancerName) => {
    const apiUrl = 'https://app.whatsgw.com.br/api/WhatsGw/Send';

    try {
        const connection = await db.getConnection();

        const [settings] = await connection.query(
            `SELECT api_key, sender_phone, message_template 
             FROM settings 
             LIMIT 1`
        );

        connection.release();

        if (settings.length === 0 || !settings[0].api_key || !settings[0].sender_phone) {
            return;
        }

        const apiKey = settings[0].api_key;
        const senderPhone = settings[0].sender_phone;
        const template = settings[0].message_template || "Olá, {name}! Um novo vídeo foi atribuído a você: {titulo}";


        if (!phone) {
            return;
        }

        const formattedPhone = normalizePhoneNumber(phone);

        if (!formattedPhone.match(/^\d+$/)) {
            return;
        }

        const messageBody = template
            .replace(/{name}/g, freelancerName)
            .replace(/{titulo}/g, videoTitle);

        const payload = {
            apikey: apiKey,
            phone_number: senderPhone,
            contact_phone_number: formattedPhone,
            message_type: 'text',
            message_body: messageBody.trim(),
            check_status: 0,
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error('Erro ao enviar mensagem pelo WhatsApp.');
        }

    } catch (error) {
        console.error('❌ Erro ao enviar mensagem pelo WhatsApp:', error.message);
    }
};

const validateFreelancerExists = async (freelancerId, connection) => {
    const [rows] = await connection.query('SELECT id FROM freelancers WHERE id = ?', [freelancerId]);
    return rows.length > 0;
};

router.post('/videos', async (req, res) => {
    const { 
        title, 
        channelId, 
        status, 
        observations, 
        youtubeUrl, 
        scriptWriterId, 
        narratorId, 
        editorId, 
        thumbMakerId, 
        userId 
    } = req.body;

    if (!title || !channelId || !status || !scriptWriterId || !narratorId || !editorId || !thumbMakerId || !userId) {
        return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }

    try {
        const connection = await req.db.getConnection();

        const validScriptWriter = await validateFreelancerExists(scriptWriterId, connection);
        const validNarrator = await validateFreelancerExists(narratorId, connection);
        const validEditor = await validateFreelancerExists(editorId, connection);
        const validThumbMaker = await validateFreelancerExists(thumbMakerId, connection);

        if (!validScriptWriter || !validNarrator || !validEditor || !validThumbMaker) {
            connection.release();
            return res.status(400).json({ message: 'Um ou mais IDs de freelancers são inválidos.' });
        }

        const [result] = await connection.query(
            `INSERT INTO videos (
                title, 
                channel_id, 
                status, 
                observations, 
                youtube_url, 
                script_writer_id, 
                narrator_id, 
                editor_id, 
                thumb_maker_id, 
                created_at, 
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [title, channelId, status, observations || null, youtubeUrl || null, scriptWriterId, narratorId, editorId, thumbMakerId]
        );

        const videoId = result.insertId;

        await connection.query(
            `INSERT INTO video_logs (
                video_id, 
                user_id, 
                action, 
                from_status, 
                to_status, 
                timestamp, 
                duration, 
                is_user
            ) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [videoId, userId, 'Vídeo criado', null, status, null, 1]
        );

        connection.release();
        res.json({ id: videoId, message: 'Vídeo criado com sucesso.' });
    } catch (error) {
        console.error('Erro ao criar vídeo:', error);
        res.status(500).json({ message: 'Erro ao criar vídeo.' });
    }
});

router.put('/videos/:id', async (req, res) => {
    const { id } = req.params;
    const { 
        title, 
        channelId, 
        status, 
        observations, 
        youtubeUrl, 
        scriptWriterId, 
        narratorId, 
        editorId, 
        thumbMakerId, 
        userId 
    } = req.body;

    if (!title || !channelId || !status || !scriptWriterId || !narratorId || !editorId || !thumbMakerId || !userId) {
        return res.status(400).json({ message: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }

    try {
        const connection = await req.db.getConnection();

        const [video] = await connection.query('SELECT * FROM videos WHERE id = ?', [id]);
        if (video.length === 0) {
            connection.release();
            return res.status(404).json({ message: 'Vídeo não encontrado.' });
        }

        const currentStatus = video[0].status;

        const validScriptWriter = await validateFreelancerExists(scriptWriterId, connection);
        const validNarrator = await validateFreelancerExists(narratorId, connection);
        const validEditor = await validateFreelancerExists(editorId, connection);
        const validThumbMaker = await validateFreelancerExists(thumbMakerId, connection);

        if (!validScriptWriter || !validNarrator || !validEditor || !validThumbMaker) {
            connection.release();
            return res.status(400).json({ message: 'Um ou mais IDs de freelancers são inválidos.' });
        }

        await connection.query(
            `UPDATE videos 
             SET 
                title = ?, 
                channel_id = ?, 
                status = ?, 
                observations = ?, 
                youtube_url = ?, 
                script_writer_id = ?, 
                narrator_id = ?, 
                editor_id = ?, 
                thumb_maker_id = ?, 
                updated_at = NOW() 
             WHERE id = ?`,
            [
                title, 
                channelId, 
                status, 
                observations || null, 
                youtubeUrl || null, 
                scriptWriterId, 
                narratorId, 
                editorId, 
                thumbMakerId, 
                id
            ]
        );

        await connection.query(
            `INSERT INTO video_logs (
                video_id, 
                user_id, 
                action, 
                from_status, 
                to_status, 
                timestamp, 
                duration, 
                is_user
            ) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [id, userId, 'Vídeo atualizado', currentStatus, status, null, 1]
        );

        connection.release();
        res.json({ message: 'Vídeo atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar o vídeo:', error);
        res.status(500).json({ message: 'Erro ao atualizar o vídeo.' });
    }
});



router.put('/videos/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, userId, isUser, sendMessage } = req.body;

    if (!status || !userId) {
        return res.status(400).json({ message: 'Status e User ID são obrigatórios.' });
    }

    const nextStatusMap = {
        'Roteiro_Concluído': 'Narração_Solicitada',
        'Narração_Concluída': 'Edição_Solicitada',
        'Edição_Concluída': 'Thumbnail_Solicitada',
        'Thumbnail_Concluída': null,
    };

    const statusToNotify = [
        'Roteiro_Solicitado',
        'Narração_Solicitada',
        'Edição_Solicitada',
        'Thumbnail_Solicitada',
    ];

    try {
        const connection = await req.db.getConnection();

        const [video] = await connection.query(
            'SELECT id, title, status, updated_at, script_writer_id, narrator_id, editor_id, thumb_maker_id FROM videos WHERE id = ?',
            [id]
        );

        if (video.length === 0) {
            connection.release();
            return res.status(404).json({ message: 'Vídeo não encontrado.' });
        }

        const {
            status: currentStatus,
            updated_at: lastUpdatedAt,
            title: videoTitle,
            script_writer_id,
            narrator_id,
            editor_id,
            thumb_maker_id,
        } = video[0];

        const [result] = await connection.query(
            'UPDATE videos SET status = ?, updated_at = NOW() WHERE id = ?',
            [status, id]
        );

        if (result.affectedRows === 0) {
            connection.release();
            return res.status(404).json({ message: 'Não foi possível atualizar o status do vídeo.' });
        }

        let duration = null;
        if (currentStatus.endsWith('_Em_Andamento') && status.endsWith('_Concluída')) {
            const startTime = new Date(lastUpdatedAt).getTime();
            const endTime = new Date().getTime();
            duration = Math.floor((endTime - startTime) / 1000);
        }

        let tableToCheck = 'freelancers';
        let userCheckQuery = 'SELECT id FROM freelancers WHERE id = ?';
        if (isUser) {
            tableToCheck = 'users';
            userCheckQuery = 'SELECT id FROM users WHERE id = ?';
        }

        const [userCheck] = await connection.query(userCheckQuery, [userId]);
        if (userCheck.length === 0) {
            connection.release();
            return res.status(404).json({ message: `Usuário não encontrado na tabela ${tableToCheck}.` });
        }

        await connection.query(
            `INSERT INTO video_logs (video_id, user_id, action, from_status, to_status, timestamp, duration, is_user)
            VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
            [id, userId, 'Status alterado', currentStatus, status, duration, isUser ? 1 : 0]
        );

        const [settings] = await connection.query('SELECT auto_notify FROM settings LIMIT 1');
        const autoNotify = settings.length > 0 ? settings[0].auto_notify : 0;

        if (statusToNotify.includes(status) && (sendMessage === 1 || autoNotify === 1)) {
            let freelancerId = null;
            if (status.startsWith('Roteiro')) freelancerId = script_writer_id;
            else if (status.startsWith('Narração')) freelancerId = narrator_id;
            else if (status.startsWith('Edição')) freelancerId = editor_id;
            else if (status.startsWith('Thumbnail')) freelancerId = thumb_maker_id;

            if (freelancerId) {
                const [freelancers] = await connection.query(
                    'SELECT name, phone FROM freelancers WHERE id = ?',
                    [freelancerId]
                );

                if (freelancers.length > 0) {
                    const { phone, name } = freelancers[0];

                    if (phone) {
                        await sendWhatsAppMessage(req.db, phone, videoTitle, name);
                    } else {
                        console.warn('⚠️ Freelancer não possui um número de telefone cadastrado.');
                    }
                } else {
                    console.warn('⚠️ Nenhum freelancer encontrado com o ID:', freelancerId);
                }
            }
        }

        const nextStatus = nextStatusMap[status];
        if (nextStatus) {
            await connection.query(
                'UPDATE videos SET status = ?, updated_at = NOW() WHERE id = ?',
                [nextStatus, id]
            );

            if (autoNotify === 1) {
                let freelancerId = null;
                if (nextStatus.startsWith('Roteiro')) freelancerId = script_writer_id;
                else if (nextStatus.startsWith('Narração')) freelancerId = narrator_id;
                else if (nextStatus.startsWith('Edição')) freelancerId = editor_id;
                else if (nextStatus.startsWith('Thumbnail')) freelancerId = thumb_maker_id;

                if (freelancerId) {
                    const [freelancers] = await connection.query(
                        'SELECT name, phone FROM freelancers WHERE id = ?',
                        [freelancerId]
                    );

                    if (freelancers.length > 0) {
                        const { phone, name } = freelancers[0];

                        if (phone) {
                            await sendWhatsAppMessage(req.db, phone, videoTitle, name);
                        } else {
                            console.warn('⚠️ Freelancer não possui um número de telefone cadastrado.');
                        }
                    } else {
                        console.warn('⚠️ Nenhum freelancer encontrado com o ID:', freelancerId);
                    }
                }
            }
        }

        connection.release();
        res.json({ message: 'Status atualizado com sucesso.' });

    } catch (error) {
        console.error('❌ Erro no update de status:', error);
        res.status(500).json({ message: 'Erro interno ao atualizar o status.' });
    }
});

router.post('/videos/:id/comments', async (req, res) => {
    const { id } = req.params;
    const { text, userId, userType } = req.body;

    if (!text) {
        return res.status(400).json({ message: 'O texto do comentário é obrigatório.' });
    }

    if (!userId || !userType) {
        return res.status(400).json({ message: 'O ID do usuário e o tipo de usuário são obrigatórios.' });
    }

    try {
        const connection = await req.db.getConnection();

        // Determine a tabela correta com base no tipo de usuário
        const userTable = userType === 'freelancer' ? 'freelancers' : 'users';
        const [userCheck] = await connection.query(
            `SELECT id, name, role FROM ${userTable} WHERE id = ?`,
            [userId]
        );

        // Verifique se o usuário existe
        if (userCheck.length === 0) {
            connection.release();
            return res.status(400).json({ message: `O ${userType} com ID ${userId} não existe.` });
        }

        // Pegue os detalhes do usuário
        const userName = userCheck[0].name;
        const userRole = userCheck[0].role;

        // Monte a consulta dinâmica para permitir NULL em user_id ou freelancer_id
        const columns = ['video_id', 'user_type', 'text', 'created_at'];
        const values = [id, userType, text, new Date()];
        let placeholders = '?, ?, ?, ?';

        if (userType === 'freelancer') {
            columns.push('freelancer_id');
            values.push(userId);
            placeholders += ', ?';
        } else {
            columns.push('user_id');
            values.push(userId);
            placeholders += ', ?';
        }

        // Insira o comentário
        const query = `INSERT INTO comments (${columns.join(', ')}) VALUES (${placeholders})`;
        await connection.query(query, values);

        connection.release();

        // Retorne a resposta com detalhes do comentário
        res.status(201).json({
            message: 'Comentário adicionado com sucesso.',
            comment: {
                text,
                userName,
                userRole,
            },
        });
    } catch (error) {
        console.error('Erro ao adicionar comentário:', error);
        res.status(500).json({ message: 'Erro ao adicionar comentário.' });
    }
});



router.get('/videos/:id/comments', async (req, res) => {
    const { id } = req.params;
    try {
        const connection = await req.db.getConnection();

        const [comments] = await connection.query(
            `
            SELECT 
                c.text,
                c.created_at,
                c.user_type,
                CASE 
                    WHEN c.user_type = 'freelancer' THEN f.name
                    WHEN c.user_type = 'user' THEN u.name
                END AS user_name,
                CASE 
                    WHEN c.user_type = 'freelancer' THEN f.role
                    WHEN c.user_type = 'user' THEN 'admin'
                END AS user_role
            FROM comments c
            LEFT JOIN freelancers f ON c.freelancer_id = f.id AND c.user_type = 'freelancer'
            LEFT JOIN users u ON c.user_id = u.id AND c.user_type = 'user'
            WHERE c.video_id = ?
            ORDER BY c.created_at DESC
            `,
            [id]
        );

        connection.release();

        res.json({
            comments: comments.map((comment) => ({
                text: comment.text,
                createdAt: comment.created_at,
                userName: comment.user_name || 'Usuário Desconhecido',
                userRole: comment.user_role || 'Role Desconhecida',
            })),
        });
    } catch (error) {
        console.error('Erro ao buscar comentários:', error);
        res.status(500).json({ message: 'Erro ao buscar comentários.' });
    }
});

router.delete('/videos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const connection = await req.db.getConnection();

        const [video] = await connection.query('SELECT * FROM videos WHERE id = ?', [id]);
        if (video.length === 0) {
            connection.release();
            return res.status(404).json({ message: 'Vídeo não encontrado.' });
        }

        await connection.query('DELETE FROM video_logs WHERE video_id = ?', [id]);

        const [result] = await connection.query('DELETE FROM videos WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            connection.release();
            return res.status(404).json({ message: 'Vídeo não encontrado.' });
        }

        connection.release();
        res.json({ message: 'Vídeo excluído com sucesso.' });
    } catch (error) {
        console.error('Erro ao excluir vídeo:', error);
        res.status(500).json({ message: 'Erro ao excluir vídeo.' });
    }
});


router.get('/channels', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const [channels] = await connection.query('SELECT id, name FROM channels');
        connection.release();

        res.json({
            message: 'Lista de canais obtida com sucesso.',
            data: channels
        });
    } catch (error) {
        console.error('Erro ao buscar canais:', error);
        res.status(500).json({ message: 'Erro ao buscar canais.' });
    }
});

router.get('/freelancers', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const [freelancers] = await connection.query('SELECT id, name, role FROM freelancers');
        connection.release();
        res.json(freelancers);
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({ message: 'Erro ao buscar freelancers.' });
    }
});

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

module.exports = router;
