const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const config = require('../config');

// Configuração do pool PostgreSQL
const pool = new Pool(config.dbConfig.postgres);

// Middleware para injetar o pool nas requisições
router.use((req, res, next) => {
  req.db = pool;
  next();
});

router.get('/dashboard', async (req, res) => {
    let client;
    try {
        client = await req.db.connect();
        const userId = req.query.userId;
        const isUser = req.query.isUser === 'true'; // Isso converterá '0' para false
        const companyId = req.query.companyId;

        // 1. Consulta Vídeos em Andamento
        let videosInProgressQuery = `
            SELECT COUNT(*) AS "videosInProgress" 
            FROM videos 
            WHERE status NOT IN ('Pendente', 'Cancelado', 'Publicado')
            ${isUser ? 'AND company_id = $1' : 'AND (script_writer_id = $1 OR editor_id = $1 OR thumb_maker_id = $1 OR narrator_id = $1) AND company_id = $2'}
        `;

        // 2. Consulta Vídeos Concluídos
        let videosCompletedQuery = `
            SELECT COUNT(*) AS "videosCompleted" 
            FROM videos 
            WHERE status = 'Publicado'
            ${isUser ? 'AND company_id = $1' : 'AND (script_writer_id = $1 OR editor_id = $1 OR thumb_maker_id = $1 OR narrator_id = $1) AND company_id = $2'}
        `;

        // 3. Consulta Freelancers Ativos
        const activeFreelancersQuery = `
            SELECT COUNT(DISTINCT id) AS "activeFreelancers" 
            FROM users 
            WHERE role IN ('roteirista', 'editor', 'narrador')
            AND company_id = $1
        `;

        const managedChannelsQuery = `
            SELECT COUNT(*) AS "managedChannels" 
            FROM channels 
            WHERE company_id = $1
        `;

        let recentActivitiesQuery = `
            SELECT 
                vl.id, 
                u.name AS "user", 
                vl.action, 
                v.title AS "content", 
                vl.old_status AS "fromStatus", 
                vl.new_status AS "toStatus",   
                EXTRACT(EPOCH FROM (NOW() - vl.created_at)) / 60 AS "minutesAgo"  
            FROM video_logs vl
            JOIN users u ON vl.user_id = u.id
            JOIN videos v ON vl.video_id = v.id
            WHERE v.company_id = $1
        `;

        if (!isUser) {
            recentActivitiesQuery += `
                AND v.id IN (
                    SELECT id 
                    FROM videos 
                    WHERE script_writer_id = $2 
                    OR editor_id = $2 
                    OR thumb_maker_id = $2 
                    OR narrator_id = $2
                )`;
        }

        recentActivitiesQuery += ' ORDER BY vl.created_at DESC LIMIT 5';

        // Configuração dos parâmetros
        const videosInProgressParams = isUser ? [companyId] : [userId, companyId];
        const videosCompletedParams = isUser ? [companyId] : [userId, companyId];
        const activeFreelancersParams = [companyId];
        const managedChannelsParams = [companyId];
        const recentActivitiesParams = isUser ? [companyId] : [companyId, userId];

        // Execução das consultas
        const [videosInProgressResult, videosCompletedResult, activeFreelancersResult, managedChannelsResult, recentActivitiesResult] = await Promise.all([
            client.query(videosInProgressQuery, videosInProgressParams),
            client.query(videosCompletedQuery, videosCompletedParams),
            client.query(activeFreelancersQuery, activeFreelancersParams),
            client.query(managedChannelsQuery, managedChannelsParams),
            client.query(recentActivitiesQuery, recentActivitiesParams)
        ]);

        // Formatação dos resultados
        const videosInProgress = parseInt(videosInProgressResult.rows[0].videosInProgress);
        const videosCompleted = parseInt(videosCompletedResult.rows[0].videosCompleted);
        const activeFreelancers = parseInt(activeFreelancersResult.rows[0].activeFreelancers);
        const managedChannels = parseInt(managedChannelsResult.rows[0].managedChannels);

        // Correção do erro: tratar casos onde toStatus é null
        const formattedActivities = recentActivitiesResult.rows.map(activity => {
            let message;
            const toStatus = (activity.toStatus || '').replace(/_/g, ' '); // Corrige o erro
            const fromStatus = (activity.fromStatus || '').replace(/_/g, ' ');

            if (toStatus.includes('Em Andamento')) {
                message = `${activity.user} iniciou "${toStatus}" no vídeo "${activity.content}".`;
            } else if (toStatus.includes('Concluído')) {
                message = `${activity.user} concluiu "${toStatus}" no vídeo "${activity.content}".`;
            } else if (toStatus) {
                message = `${activity.user} alterou o status para "${toStatus}" no vídeo "${activity.content}".`;
            } else {
                message = `${activity.user} realizou a ação "${activity.action}" no vídeo "${activity.content}".`;
            }

            const minutesAgo = Math.floor(activity.minutesAgo);
            const timeAgo = minutesAgo < 60 
                ? `${minutesAgo} min atrás`
                : `${Math.floor(minutesAgo / 60)}h atrás`;

            return {
                id: activity.id,
                message,
                time: timeAgo,
            };
        });

        res.json({
            stats: {
                videosInProgress,
                videosCompleted,
                activeFreelancers,
                managedChannels,
            },
            recentActivities: formattedActivities,
        });
    } catch (error) {
        console.error('Erro ao buscar dados do dashboard:', error);
        res.status(500).json({ 
            message: 'Erro ao buscar dados do dashboard.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;