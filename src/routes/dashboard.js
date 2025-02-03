const express = require('express');
const router = express.Router();

router.get('/dashboard', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const userId = req.query.userId;
        const isUser = req.query.isUser === '1';

        let videosInProgressQuery = "SELECT COUNT(*) AS videosInProgress FROM videos WHERE status NOT IN ('Pendente', 'Cancelado', 'Publicado')";
        let videosCompletedQuery = "SELECT COUNT(*) AS videosCompleted FROM videos WHERE status = 'Publicado'";
        let recentActivitiesQuery = `SELECT 
                                        vl.id, 
                                        f.name AS user, 
                                        vl.action, 
                                        v.title AS content, 
                                        vl.from_status AS fromStatus, 
                                        vl.to_status AS toStatus, 
                                        TIMESTAMPDIFF(MINUTE, vl.timestamp, NOW()) AS minutesAgo 
                                    FROM video_logs vl
                                    JOIN freelancers f ON vl.user_id = f.id
                                    JOIN videos v ON vl.video_id = v.id`;

        if (!isUser) {
            videosInProgressQuery += ` AND (script_writer_id = ? OR editor_id = ? OR thumb_maker_id = ? OR narrator_id = ?)`;
            videosCompletedQuery += ` AND (script_writer_id = ? OR editor_id = ? OR thumb_maker_id = ? OR narrator_id = ?)`;
            recentActivitiesQuery += ` WHERE v.id IN (SELECT id FROM videos WHERE script_writer_id = ? OR editor_id = ? OR thumb_maker_id = ? OR narrator_id = ?)`;
        } else {
            recentActivitiesQuery += ` WHERE v.id IN (SELECT id FROM videos)`;
        }

        recentActivitiesQuery += ` ORDER BY vl.timestamp DESC LIMIT 5`;

        const [[{ videosInProgress }]] = await connection.query(videosInProgressQuery, isUser ? [] : [userId, userId, userId, userId]);
        const [[{ videosCompleted }]] = await connection.query(videosCompletedQuery, isUser ? [] : [userId, userId, userId, userId]);
        const [[{ activeFreelancers }]] = await connection.query(
            "SELECT COUNT(DISTINCT id) AS activeFreelancers FROM users WHERE role IN ('roteirista', 'editor', 'narrador')"
        );
        const [[{ managedChannels }]] = await connection.query("SELECT COUNT(*) AS managedChannels FROM channels");

        const [recentActivities] = await connection.query(recentActivitiesQuery, isUser ? [] : [userId, userId, userId, userId]);

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
