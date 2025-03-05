const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

router.get('/channels3', async (req, res) => {
    let client;
    try {
        const companyId = req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        const result = await client.query(
            'SELECT id, name FROM channels WHERE company_id = $1',
            [companyId]
        );

        res.json({ channels: result.rows });
    } catch (error) {
        console.error('Erro ao buscar canais:', error);
        res.status(500).json({
            message: 'Erro ao buscar canais.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/freelancers2', async (req, res) => {
    let client;
    try {
        const companyId = req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        const result = await client.query(
            'SELECT id, name FROM freelancers WHERE company_id = $1',
            [companyId]
        );

        res.json({ data: result.rows });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({
            message: 'Erro ao buscar freelancers.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/reports/data', async (req, res) => {
    let client;
    try {
        const {
            companyId,
            startDate,
            endDate,
            channelId,
            freelancerId,
            status
        } = req.query;

        if (!companyId) {
            return res.status(400).json({
                code: 'MISSING_COMPANY_ID',
                message: 'Company ID é obrigatório'
            });
        }

        client = await req.db.connect();
        let queryParams = [companyId];

        // Query atualizada para retornar cada log como entrada única
        let query = `
            SELECT 
                l.id AS "logId",
                v.id AS "videoId",
                c.name AS "channelName",
                v.title AS "videoTitle",
                l.from_status AS "fromStatus",
                l.to_status AS "toStatus",
                l.created_at AS "logDate",
                l.duration AS "durationSeconds",
                l.freelancer_id AS "freelancerId"
            FROM video_logs l
            INNER JOIN videos v ON l.video_id = v.id
            LEFT JOIN channels c ON v.channel_id = c.id
            WHERE v.company_id = $1
            AND l.action = 'status_change'
        `;

        const addCondition = (value, column, operator = '>=') => {
            if (value) {
                queryParams.push(value);
                query += ` AND ${column} ${operator} $${queryParams.length}`;
            }
        };

        // Filtros baseados nos logs
        addCondition(startDate, 'l.created_at');
        addCondition(endDate, 'l.created_at', '<=');

        if (channelId) {
            queryParams.push(channelId);
            query += ` AND v.channel_id = $${queryParams.length}`;
        }

        if (freelancerId) {
            queryParams.push(freelancerId);
            query += ` AND l.freelancer_id = $${queryParams.length}`;
        }

        if (status) {
            const statusList = status.split(',');
            query += ` AND l.to_status IN (${statusList.map((_, i) => `$${queryParams.length + i + 1}`).join(',')})`;
            queryParams.push(...statusList);
        }

        query += ` ORDER BY l.created_at DESC`;

        const result = await client.query(query, queryParams);

        // Formatação dos dados
        const reportData = result.rows.map(item => {
            const totalSeconds = Number(item.durationSeconds) || 0;
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = Math.floor(totalSeconds % 60);

            return {
                id: item.logId,
                videoId: item.videoId,
                channelName: item.channelName,
                videoTitle: item.videoTitle,
                logDate: item.logDate,
                statusTransition: {
                    from: item.fromStatus?.replace(/_/g, ' ') || 'Não Definido',
                    to: item.toStatus?.replace(/_/g, ' ') || 'Não Definido'
                },
                duration: {
                    formatted: `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`,
                    seconds: totalSeconds
                },
                freelancerId: item.freelancerId
            };
        });

        res.json(reportData);

    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({
            code: 'REPORT_ERROR',
            message: 'Erro na geração do relatório'
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/reports/stats', async (req, res) => {
    let client;
    try {
        const { companyId, startDate, endDate, channelId, freelancerId, status } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        const queryParams = [companyId];
        const statusList = status ? status.split(',') : [];

        let query = `
            SELECT 
                COUNT(*) AS totaltasks,
                COALESCE(AVG(logs.totalduration), 0) AS averagetime,
                (
                    SELECT f.name
                    FROM (
                        SELECT script_writer_id AS freelancer_id, created_at, channel_id, status 
                        FROM videos WHERE company_id = $1
                        UNION ALL
                        SELECT editor_id, created_at, channel_id, status 
                        FROM videos WHERE company_id = $1
                        UNION ALL
                        SELECT narrator_id, created_at, channel_id, status 
                        FROM videos WHERE company_id = $1
                        UNION ALL
                        SELECT thumb_maker_id, created_at, channel_id, status 
                        FROM videos WHERE company_id = $1
                    ) v2
                    JOIN freelancers f ON v2.freelancer_id = f.id
                    WHERE 1=1
        `;

        // Adicionar filtros para topFreelancer
        let paramIndex = queryParams.length + 1;
        if (startDate) {
            query += ` AND v2.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }
        if (endDate) {
            query += ` AND v2.created_at <= $${paramIndex}`;
            queryParams.push(endDate);
            paramIndex++;
        }
        if (channelId) {
            query += ` AND v2.channel_id = $${paramIndex}`;
            queryParams.push(channelId);
            paramIndex++;
        }
        if (status) {
            query += ` AND v2.status IN (${statusList.map((_, i) => `$${paramIndex + i}`).join(',')})`;
            queryParams.push(...statusList);
            paramIndex += statusList.length;
        }

        query += `
                    GROUP BY f.id
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                ) AS topfreelancer,
                (
                    SELECT c.name 
                    FROM channels c
                    JOIN videos v2 ON v2.channel_id = c.id
                    WHERE v2.company_id = $1
        `;

        // Adicionar filtros para topChannel
        paramIndex = queryParams.length + 1;
        if (startDate) {
            query += ` AND v2.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }
        if (endDate) {
            query += ` AND v2.created_at <= $${paramIndex}`;
            queryParams.push(endDate);
            paramIndex++;
        }
        if (freelancerId) {
            query += `
                AND (
                    v2.script_writer_id = $${paramIndex}
                    OR v2.editor_id = $${paramIndex + 1}
                    OR v2.narrator_id = $${paramIndex + 2}
                    OR v2.thumb_maker_id = $${paramIndex + 3}
                )
            `;
            queryParams.push(freelancerId, freelancerId, freelancerId, freelancerId);
            paramIndex += 4;
        }
        if (status) {
            query += ` AND v2.status IN (${statusList.map((_, i) => `$${paramIndex + i}`).join(',')})`;
            queryParams.push(...statusList);
        }

        query += `
                    GROUP BY c.id
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                ) AS topchannel
            FROM videos v
            LEFT JOIN (
                SELECT video_id, SUM(duration) AS totalduration
                FROM video_logs
                GROUP BY video_id
            ) logs ON v.id = logs.video_id
            WHERE v.company_id = $1
        `;

        // Filtros principais
        paramIndex = queryParams.length + 1;
        if (startDate) {
            query += ` AND v.created_at >= $${paramIndex}`;
            queryParams.push(startDate);
            paramIndex++;
        }
        if (endDate) {
            query += ` AND v.created_at <= $${paramIndex}`;
            queryParams.push(endDate);
            paramIndex++;
        }
        if (channelId) {
            query += ` AND v.channel_id = $${paramIndex}`;
            queryParams.push(channelId);
            paramIndex++;
        }
        if (freelancerId) {
            query += `
                AND (
                    v.script_writer_id = $${paramIndex}
                    OR v.editor_id = $${paramIndex + 1}
                    OR v.narrator_id = $${paramIndex + 2}
                    OR v.thumb_maker_id = $${paramIndex + 3}
                )
            `;
            queryParams.push(freelancerId, freelancerId, freelancerId, freelancerId);
            paramIndex += 4;
        }
        if (status) {
            query += ` AND v.status IN (${statusList.map((_, i) => `$${paramIndex + i}`).join(',')})`;
            queryParams.push(...statusList);
        }

        const result = await client.query(query, queryParams);
        const stats = result.rows[0];

        if (stats.averagetime) {
            const totalSeconds = Math.round(stats.averagetime);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            stats.averagetimeformatted = `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
        } else {
            stats.averagetimeformatted = '0m 0s';
        }

        res.json(stats);
    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            message: 'Erro ao buscar estatísticas.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/reports/status', async (req, res) => {
    let client;
    try {
        const { companyId, startDate, endDate, channelId, freelancerId, status } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        let queryParams = [companyId];

        let query = `
            SELECT v.status, COUNT(*) 
            FROM videos v
            WHERE v.company_id = $1
        `;

        if (startDate) {
            queryParams.push(startDate);
            query += ` AND v.created_at >= $${queryParams.length}`;
        }

        if (endDate) {
            queryParams.push(endDate);
            query += ` AND v.created_at <= $${queryParams.length}`;
        }

        if (channelId) {
            queryParams.push(channelId);
            query += ` AND v.channel_id = $${queryParams.length}`;
        }

        if (freelancerId) {
            queryParams.push(freelancerId, freelancerId, freelancerId);
            query += `
                AND (
                    v.script_writer_id = $${queryParams.length - 2}
                    OR v.editor_id = $${queryParams.length - 1}
                    OR v.narrator_id = $${queryParams.length}
                )
            `;
        }

        if (status) {
            const statusList = status.split(',');
            query += ` AND v.status IN (${statusList.map((_, i) => `$${queryParams.length + i + 1}`).join(',')})`;
            queryParams.push(...statusList);
        }

        query += ' GROUP BY v.status';

        const result = await client.query(query, queryParams);
        res.json(result.rows.map(row => ({
            status: row.status,
            count: row.count
        })));
    } catch (error) {
        console.error('Erro ao buscar contagem de status:', error);
        res.status(500).json({
            message: 'Erro ao buscar contagem de status.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/reports/export', async (req, res) => {
    let client;
    try {
        const { companyId, format, startDate, endDate, channelId, freelancerId, status } = req.query;

        if (!companyId) {
            return res.status(400).json({ message: 'Company ID é obrigatório' });
        }

        client = await req.db.connect();
        let queryParams = [companyId];

        let query = `
            SELECT 
                v.id,
                c.name AS channelname,
                v.title AS videotitle,
                v.status,
                COALESCE(AVG(l.duration), 0) AS averagetimeinseconds,
                v.created_at AS createdat
            FROM videos v
            LEFT JOIN channels c ON v.channel_id = c.id
            LEFT JOIN video_logs l ON v.id = l.video_id
            WHERE v.company_id = $1
        `;

        if (startDate) {
            queryParams.push(startDate);
            query += ` AND v.created_at >= $${queryParams.length}`;
        }

        if (endDate) {
            queryParams.push(endDate);
            query += ` AND v.created_at <= $${queryParams.length}`;
        }

        if (channelId) {
            queryParams.push(channelId);
            query += ` AND v.channel_id = $${queryParams.length}`;
        }

        if (freelancerId) {
            queryParams.push(freelancerId, freelancerId, freelancerId, freelancerId);
            query += `
                AND (
                    v.script_writer_id = $${queryParams.length - 3}
                    OR v.editor_id = $${queryParams.length - 2}
                    OR v.narrator_id = $${queryParams.length - 1}
                    OR v.thumb_maker_id = $${queryParams.length}
                )
            `;
        }

        if (status) {
            const statusList = status.split(',');
            query += ` AND v.status IN (${statusList.map((_, i) => `$${queryParams.length + i + 1}`).join(',')})`;
            queryParams.push(...statusList);
        }

        query += ' GROUP BY v.id, c.name, v.title, v.status, v.created_at';

        const result = await client.query(query, queryParams);
        const reportData = result.rows.map(item => {
            const totalSeconds = Number(item.averagetimeinseconds);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = Math.floor(totalSeconds % 60);

            return {
                ...item,
                averageTime: `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`
            };
        });

        client.release();

        // Restante do código de exportação...
        const exportsDir = path.join(__dirname, '../exports');
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }

        if (format === 'pdf') {
            const doc = new PDFDocument({ margin: 30 });
            const filePath = path.join(exportsDir, 'report.pdf');
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            doc.fontSize(18).text('Relatório de Vídeos', { align: 'center' });
            doc.moveDown();

            reportData.forEach((data) => {
                doc.fontSize(12)
                    .text(`Canal: ${data.channelname || 'N/A'}`)
                    .text(`Vídeo: ${data.videotitle}`)
                    .text(`Status: ${data.status}`)
                    .text(`Tempo Médio: ${data.averageTime}`)
                    .text(`Data: ${new Date(data.createdat).toLocaleDateString()}`)
                    .moveDown();
            });

            doc.end();

            stream.on('finish', () => {
                res.download(filePath, 'report.pdf', (err) => {
                    if (err) throw err;
                    fs.unlinkSync(filePath);
                });
            });
        } else if (format === 'excel') {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Relatório');

            worksheet.columns = [
                { header: 'Canal', key: 'channel', width: 25 },
                { header: 'Vídeo', key: 'video', width: 35 },
                { header: 'Status', key: 'status', width: 15 },
                { header: 'Tempo Médio', key: 'time', width: 20 },
                { header: 'Data', key: 'date', width: 20 },
            ];

            worksheet.addRows(reportData.map(item => ({
                channel: item.channelname,
                video: item.videotitle,
                status: item.status,
                time: item.averageTime,
                date: new Date(item.createdat).toLocaleDateString()
            })));

            const filePath = path.join(exportsDir, 'report.xlsx');
            await workbook.xlsx.writeFile(filePath);
            res.download(filePath, 'report.xlsx', (err) => {
                if (err) throw err;
                fs.unlinkSync(filePath);
            });
        } else {
            res.status(400).json({ message: 'Formato inválido. Use "pdf" ou "excel".' });
        }
    } catch (error) {
        console.error('Erro ao exportar relatório:', error);
        res.status(500).json({
            message: 'Erro ao exportar relatório.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;