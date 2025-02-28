const express = require('express');
const { Pool } = require('pg');
const config = require('../config');
const router = express.Router();

const pool = new Pool(config.dbConfig.postgres);

router.use((req, res, next) => {
  req.db = pool;
  next();
});

router.get('/channels', async (req, res) => {
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    try {
        client = await req.db.connect();

        const channelsQuery = `
            SELECT
                c.id,
                c.name,
                c.description,
                c.youtube_url AS "youtubeUrl",
                COUNT(v.id) AS "totalVideos",
                SUM(CASE WHEN EXTRACT(MONTH FROM v.created_at) = EXTRACT(MONTH FROM CURRENT_DATE) THEN 1 ELSE 0 END) AS "monthlyVideos"
            FROM channels c
            LEFT JOIN videos v ON v.channel_id = c.id
            WHERE c.company_id = $1 AND c.enabled = true
            GROUP BY c.id
        `;

        const totalVideosQuery = `
            SELECT
                COUNT(*) AS "totalMonthlyVideos"
            FROM videos
            WHERE company_id = $1 
            AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
        `;

        const channelsResult = await client.query(channelsQuery, [companyId]);
        const totalVideosResult = await client.query(totalVideosQuery, [companyId]);

        res.json({
            channels: channelsResult.rows,
            totalMonthlyVideos: totalVideosResult.rows[0].totalMonthlyVideos,
        });
    } catch (error) {
        console.error('Erro ao buscar canais:', {
            error: error.message,
            stack: error.stack,
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao buscar canais.',
            errorCode: 'CHANNEL_FETCH_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

router.post('/channels', async (req, res) => {
    const { name, description, youtubeUrl } = req.body;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    if (!name || !description || !youtubeUrl) {
        return res.status(400).json({ 
            message: 'Todos os campos são obrigatórios.',
            requiredFields: ['name', 'description', 'youtubeUrl'],
            errorCode: 'MISSING_REQUIRED_FIELDS'
        });
    }

    try {
        client = await req.db.connect();

        const insertQuery = `
            INSERT INTO channels (
                name, 
                description, 
                youtube_url, 
                company_id, 
                created_at, 
                updated_at
            ) VALUES ($1, $2, $3, $4, NOW(), NOW())
            RETURNING id, created_at
        `;

        const result = await client.query(insertQuery, [
            name, 
            description, 
            youtubeUrl, 
            companyId
        ]);

        res.json({ 
            id: result.rows[0].id,
            message: 'Canal criado com sucesso.',
            createdAt: result.rows[0].created_at
        });
    } catch (error) {
        console.error('Erro ao criar canal:', {
            error: error.message,
            params: { name, description, youtubeUrl: youtubeUrl.slice(0, 20) },
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao criar canal.',
            errorCode: 'CHANNEL_CREATION_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

router.put('/channels/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, youtubeUrl } = req.body;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    if (!name || !description || !youtubeUrl) {
        return res.status(400).json({ 
            message: 'Todos os campos são obrigatórios.',
            requiredFields: ['name', 'description', 'youtubeUrl'],
            errorCode: 'MISSING_REQUIRED_FIELDS'
        });
    }

    try {
        client = await req.db.connect();

        const updateQuery = `
            UPDATE channels 
            SET 
                name = $1, 
                description = $2, 
                youtube_url = $3, 
                updated_at = NOW() 
            WHERE id = $4 AND company_id = $5
            RETURNING *
        `;

        const result = await client.query(updateQuery, [
            name, 
            description, 
            youtubeUrl, 
            id, 
            companyId
        ]);

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                message: 'Canal não encontrado ou não pertence à empresa.',
                errorCode: 'CHANNEL_NOT_FOUND'
            });
        }

        res.json({ 
            message: 'Canal atualizado com sucesso.',
            updatedAt: result.rows[0].updated_at
        });
    } catch (error) {
        console.error('Erro ao atualizar canal:', {
            error: error.message,
            channelId: id,
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao atualizar canal.',
            errorCode: 'CHANNEL_UPDATE_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

router.delete('/channels/:id', async (req, res) => {
    const { id } = req.params;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    try {
        client = await req.db.connect();
        await client.query('BEGIN');

        // Excluir logs de vídeos não publicados
        await client.query(`
            DELETE FROM video_logs
            WHERE video_id IN (
                SELECT id FROM videos
                WHERE channel_id = $1 
                AND company_id = $2 
                AND status != 'Publicado'
            )
        `, [id, companyId]);

        // Excluir vídeos não publicados
        await client.query(`
            DELETE FROM videos
            WHERE channel_id = $1 
            AND company_id = $2 
            AND status != 'Publicado'
        `, [id, companyId]);

        // Desabilitar canal
        const updateResult = await client.query(`
            UPDATE channels
            SET enabled = false
            WHERE id = $1 AND company_id = $2
        `, [id, companyId]);

        if (updateResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                message: 'Canal não encontrado ou não pertence à empresa.',
                errorCode: 'CHANNEL_NOT_FOUND'
            });
        }

        await client.query('COMMIT');
        res.json({ 
            message: 'Canal desabilitado com sucesso.',
            disabledAt: new Date().toISOString()
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao desabilitar canal:', {
            error: error.message,
            channelId: id,
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao desabilitar canal.',
            errorCode: 'CHANNEL_DELETION_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;