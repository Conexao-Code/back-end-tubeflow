const express = require('express');
const router = express.Router();

router.get('/dashboard', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const userId = req.query.userId;
        const isUser = req.query.isUser === '1';
        const companyId = req.query.companyId;

        // 1. Consulta Vídeos em Andamento
        let videosInProgressQuery = `
            SELECT COUNT(*) AS videosInProgress 
            FROM videos 
            WHERE status NOT IN ('Pendente', 'Cancelado', 'Publicado')
            ${isUser ? 'AND company_id = ?' : 'AND (script_writer_id = ? OR editor_id = ? OR thumb_maker_id = ? OR narrator_id = ?) AND company_id = ?'}
        `;

        // 2. Consulta Vídeos Concluídos
        let videosCompletedQuery = `
            SELECT COUNT(*) AS videosCompleted 
            FROM videos 
            WHERE status = 'Publicado'
            ${isUser ? 'AND company_id = ?' : 'AND (script_writer_id = ? OR editor_id = ? OR thumb_maker_id = ? OR narrator_id = ?) AND company_id = ?'}
        `;

        // 3. Consulta Freelancers Ativos
        const activeFreelancersQuery = `
            SELECT COUNT(DISTINCT id) AS activeFreelancers 
            FROM users 
            WHERE role IN ('roteirista', 'editor', 'narrador')
            AND company_id = ?
        `;

        // 4. Consulta Canais Gerenciados
        const managedChannelsQuery = `
            SELECT COUNT(*) AS managedChannels 
            FROM channels 
            WHERE company_id = ?
        `;

        // 5. Consulta Atividades Recentes
        let recentActivitiesQuery = `
            SELECT 
                vl.id, 
                f.name AS user, 
                vl.action, 
                v.title AS content, 
                vl.from_status AS fromStatus, 
                vl.to_status AS toStatus, 
                TIMESTAMPDIFF(MINUTE, vl.timestamp, NOW()) AS minutesAgo 
            FROM video_logs vl
            JOIN freelancers f ON vl.user_id = f.id
            JOIN videos v ON vl.video_id = v.id
            WHERE v.company_id = ?
        `;

        if (!isUser) {
            recentActivitiesQuery += `
                AND v.id IN (
                    SELECT id 
                    FROM videos 
                    WHERE script_writer_id = ? 
                    OR editor_id = ? 
                    OR thumb_maker_id = ? 
                    OR narrator_id = ?
                )`;
        }

        recentActivitiesQuery += ' ORDER BY vl.timestamp DESC LIMIT 5';

        // Configuração dos parâmetros
        const videosInProgressParams = isUser 
            ? [companyId] 
            : [userId, userId, userId, userId, companyId];

        const videosCompletedParams = isUser 
            ? [companyId] 
            : [userId, userId, userId, userId, companyId];

        const activeFreelancersParams = [companyId];
        const managedChannelsParams = [companyId];
        const recentActivitiesParams = isUser 
            ? [companyId] 
            : [companyId, userId, userId, userId, userId];

        // Execução das consultas
        const [[{ videosInProgress }]] = await connection.query(videosInProgressQuery, videosInProgressParams);
        const [[{ videosCompleted }]] = await connection.query(videosCompletedQuery, videosCompletedParams);
        const [[{ activeFreelancers }]] = await connection.query(activeFreelancersQuery, activeFreelancersParams);
        const [[{ managedChannels }]] = await connection.query(managedChannelsQuery, managedChannelsParams);
        const [recentActivities] = await connection.query(recentActivitiesQuery, recentActivitiesParams);

        // Formatação das atividades
        const formattedActivities = recentActivities.map(activity => {
            let message;

            if (activity.toStatus.includes('Em_Andamento')) {
                message = `${activity.user} deu início ao status \"${activity.toStatus.replace(/_/g, ' ')}\" para o vídeo \"${activity.content}\".`;
            } else if (activity.toStatus.includes('Concluído')) {
                message = `${activity.user} concluiu o status \"${activity.toStatus.replace(/_/g, ' ')}\" para o vídeo \"${activity.content}\".`;
            } else {
                message = `${activity.user} alterou o status do vídeo \"${activity.content}\" para \"${activity.toStatus.replace(/_/g, ' ')}\".`;
            }

            const timeAgo = activity.minutesAgo < 60
                ? `${activity.minutesAgo} min atrás`
                : `${Math.floor(activity.minutesAgo / 60)}h atrás`;

            return {
                id: activity.id,
                message,
                time: timeAgo,
            };
        });

        connection.release();

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
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});

module.exports = router;