const express = require('express');
const router = express.Router();

router.get('/channels', async (req, res) => {
    try {
        const connection = await req.db.getConnection();

        const [channels] = await connection.query(`
            SELECT
                c.id,
                c.name,
                c.description,
                c.youtube_url AS youtubeUrl,
                COUNT(v.id) AS totalVideos,
                SUM(CASE WHEN MONTH(v.created_at) = MONTH(NOW()) THEN 1 ELSE 0 END) AS monthlyVideos
            FROM channels c
            LEFT JOIN videos v ON v.channel_id = c.id
            GROUP BY c.id
        `);

        const [totalVideosResult] = await connection.query(`
            SELECT
                COUNT(*) AS totalMonthlyVideos
            FROM videos
            WHERE MONTH(created_at) = MONTH(NOW())
        `);

        connection.release();

        res.json({
            channels,
            totalMonthlyVideos: totalVideosResult[0].totalMonthlyVideos,
        });
    } catch (error) {
        console.error('Erro ao buscar canais com totais:', error);
        res.status(500).json({ message: 'Erro ao buscar canais com totais.' });
    }
});

router.post('/channels', async (req, res) => {
    const { name, description, youtubeUrl } = req.body;

    if (!name || !description || !youtubeUrl) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }

    try {
        const connection = await req.db.getConnection();
        const [result] = await connection.query(
            'INSERT INTO channels (name, description, youtube_url, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
            [name, description, youtubeUrl]
        );
        connection.release();

        res.json({ id: result.insertId, message: 'Canal criado com sucesso.' });
    } catch (error) {
        console.error('Erro ao criar canal:', error);
        res.status(500).json({ message: 'Erro ao criar canal.' });
    }
});

router.put('/channels/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, youtubeUrl } = req.body;

    if (!name || !description || !youtubeUrl) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }

    try {
        const connection = await req.db.getConnection();
        const [result] = await connection.query(
            'UPDATE channels SET name = ?, description = ?, youtube_url = ?, updated_at = NOW() WHERE id = ?',
            [name, description, youtubeUrl, id]
        );
        connection.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Canal não encontrado.' });
        }

        res.json({ message: 'Canal atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao editar canal:', error);
        res.status(500).json({ message: 'Erro ao editar canal.' });
    }
});

router.delete('/channels/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const connection = await req.db.getConnection();

        await connection.query(`
            DELETE vl
            FROM video_logs vl
            INNER JOIN videos v ON vl.video_id = v.id
            WHERE v.channel_id = ?
        `, [id]);

        await connection.query('DELETE FROM videos WHERE channel_id = ?', [id]);

        const [result] = await connection.query('DELETE FROM channels WHERE id = ?', [id]);
        connection.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Canal não encontrado.' });
        }

        res.json({ message: 'Canal excluído com sucesso.' });
    } catch (error) {
        console.error('Erro ao excluir canal:', error);
        res.status(500).json({ message: 'Erro ao excluir canal.' });
    }
});


module.exports = router;
