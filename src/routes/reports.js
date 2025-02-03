const express = require('express');
const router = express.Router();

router.get('/channels', async (req, res) => {
    try {
        const connection = await req.db.getConnection();

        const [channels] = await connection.query("SELECT id, name FROM channels");

        connection.release();
        res.json({ channels });
    } catch (error) {
        console.error('Erro ao buscar canais:', error);
        res.status(500).json({ message: 'Erro ao buscar canais.' });
    }
});

router.get('/freelancers2', async (req, res) => {
    try {
        const connection = await req.db.getConnection();

        const [freelancers] = await connection.query("SELECT id, name FROM freelancers");

        connection.release();
        res.json({ data: freelancers });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({ message: 'Erro ao buscar freelancers.' });
    }
});

router.get('/reports/data', async (req, res) => {
    try {
        const { startDate, endDate, channelId, freelancerId, status } = req.query;
        const connection = await req.db.getConnection();

        let query = `
        SELECT 
          v.id,
          c.name AS channelName,
          v.title AS videoTitle,
          v.status,
          COALESCE(AVG(l.duration), 0) AS averageTimeInSeconds,
          v.created_at AS createdAt
        FROM videos v
        LEFT JOIN channels c ON v.channel_id = c.id
        LEFT JOIN video_logs l ON v.id = l.video_id
        WHERE 1=1
      `;

        const params = [];

        if (startDate) {
            query += " AND v.created_at >= ?";
            params.push(startDate);
        }

        if (endDate) {
            query += " AND v.created_at <= ?";
            params.push(endDate);
        }

        if (channelId) {
            query += " AND v.channel_id = ?";
            params.push(channelId);
        }

        if (freelancerId) {
            query += ` AND (
          v.script_writer_id = ? OR 
          v.editor_id = ? OR 
          v.narrator_id = ? OR 
          v.thumb_maker_id = ?
        )`;
            params.push(freelancerId, freelancerId, freelancerId, freelancerId);
        }

        if (status) {
            const statusArray = status.split(',');
            query += ` AND v.status IN (${statusArray.map(() => '?').join(',')})`;
            params.push(...statusArray);
        }

        query += " GROUP BY v.id";

        const [reportData] = await connection.query(query, params);

        const formattedReportData = reportData.map(item => {
            const totalSeconds = Number(item.averageTimeInSeconds);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = Math.floor(totalSeconds % 60);
            return {
                ...item,
                averageTime: `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`
            };
        });

        connection.release();
        res.json(formattedReportData);
    } catch (error) {
        console.error('Erro ao gerar dados do relatório:', error);
        res.status(500).json({ message: 'Erro ao gerar dados do relatório.' });
    }
});


router.get('/reports/stats', async (req, res) => {
    try {
        const { startDate, endDate, channelId, freelancerId, status } = req.query;
        const connection = await req.db.getConnection();
        const statusArray = status ? status.split(',') : [];

        let query = `
            SELECT 
                COUNT(*) AS totalTasks,
                COALESCE(AVG(logs.totalDuration), 0) AS averageTime,
                (
                    SELECT f.name
                    FROM (
                        SELECT script_writer_id AS freelancer_id, created_at, channel_id, status FROM videos
                        UNION ALL
                        SELECT editor_id, created_at, channel_id, status FROM videos
                        UNION ALL
                        SELECT narrator_id, created_at, channel_id, status FROM videos
                        UNION ALL
                        SELECT thumb_maker_id, created_at, channel_id, status FROM videos
                    ) v2
                    JOIN freelancers f ON v2.freelancer_id = f.id
                    WHERE 1=1
        `;

        const params = [];

        // Filtros para a subquery do topFreelancer
        if (startDate) {
            query += " AND v2.created_at >= ?";
            params.push(startDate);
        }
        if (endDate) {
            query += " AND v2.created_at <= ?";
            params.push(endDate);
        }
        if (channelId) {
            query += " AND v2.channel_id = ?";
            params.push(channelId);
        }
        if (status) {
            query += ` AND v2.status IN (${statusArray.map(() => '?').join(',')})`;
            params.push(...statusArray);
        }

        query += `
                    GROUP BY f.id
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                ) AS topFreelancer,
                (
                    SELECT c.name 
                    FROM channels c
                    JOIN videos v2 ON v2.channel_id = c.id
                    WHERE 1=1
        `;

        // Filtros para a subquery do topChannel
        if (startDate) {
            query += " AND v2.created_at >= ?";
            params.push(startDate);
        }
        if (endDate) {
            query += " AND v2.created_at <= ?";
            params.push(endDate);
        }
        if (freelancerId) {
            query += ` AND (
                v2.script_writer_id = ? OR 
                v2.editor_id = ? OR 
                v2.narrator_id = ? OR 
                v2.thumb_maker_id = ?
            )`;
            params.push(freelancerId, freelancerId, freelancerId, freelancerId);
        }
        if (status) {
            query += ` AND v2.status IN (${statusArray.map(() => '?').join(',')})`;
            params.push(...statusArray);
        }

        query += `
                    GROUP BY c.id
                    ORDER BY COUNT(*) DESC
                    LIMIT 1
                ) AS topChannel
            FROM videos v
            LEFT JOIN (
                SELECT video_id, SUM(duration) AS totalDuration
                FROM video_logs
                GROUP BY video_id
            ) logs ON v.id = logs.video_id
            WHERE 1=1
        `;

        // Filtros para a query principal
        if (startDate) {
            query += " AND v.created_at >= ?";
            params.push(startDate);
        }
        if (endDate) {
            query += " AND v.created_at <= ?";
            params.push(endDate);
        }
        if (channelId) {
            query += " AND v.channel_id = ?";
            params.push(channelId);
        }
        if (freelancerId) {
            query += ` AND (
                v.script_writer_id = ? OR 
                v.editor_id = ? OR 
                v.narrator_id = ? OR 
                v.thumb_maker_id = ?
            )`;
            params.push(freelancerId, freelancerId, freelancerId, freelancerId);
        }
        if (status) {
            query += ` AND v.status IN (${statusArray.map(() => '?').join(',')})`;
            params.push(...statusArray);
        }

        const [stats] = await connection.query(query, params);

        if (stats[0] && stats[0].averageTime) {
            const totalSeconds = Math.round(stats[0].averageTime);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            stats[0].averageTimeFormatted = `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
        } else {
            stats[0].averageTimeFormatted = '0m 0s';
        }

        connection.release();
        res.json(stats[0]);
    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({ message: 'Erro ao buscar estatísticas.' });
    }
});

router.get('/reports/status', async (req, res) => {
    try {
        const { startDate, endDate, channelId, freelancerId, status } = req.query;
        const connection = await req.db.getConnection();

        let query = `SELECT v.status, COUNT(*) AS count 
        FROM videos v
        WHERE 1=1`;

        const params = [];

        if (startDate) {
            query += " AND v.created_at >= ?";
            params.push(startDate);
        }

        if (endDate) {
            query += " AND v.created_at <= ?";
            params.push(endDate);
        }

        if (channelId) {
            query += " AND v.channel_id = ?";
            params.push(channelId);
        }

        if (freelancerId) {
            query += " AND (v.script_writer_id = ? OR v.editor_id = ? OR v.narrator_id = ?)";
            params.push(freelancerId, freelancerId, freelancerId);
        }

        if (status) {
            const statusArray = status.split(',');
            query += ` AND v.status IN (${statusArray.map(() => '?').join(',')})`;
            params.push(...statusArray);
        }

        query += " GROUP BY v.status";

        const [statusCounts] = await connection.query(query, params);

        connection.release();
        res.json(statusCounts);
    } catch (error) {
        console.error('Erro ao buscar contagem de status:', error);
        res.status(500).json({ message: 'Erro ao buscar contagem de status.' });
    }
});

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

router.get('/reports/export', async (req, res) => {
    try {
        const { format, startDate, endDate, channelId, freelancerId, status } = req.query;
        const connection = await req.db.getConnection();
        const requestedFormat = format ? format.trim().toLowerCase() : null;

        let query = `
        SELECT 
          v.id,
          c.name AS channelName,
          v.title AS videoTitle,
          v.status,
          COALESCE(AVG(l.duration), 0) AS averageTimeInSeconds,
          v.created_at AS createdAt
        FROM videos v
        LEFT JOIN channels c ON v.channel_id = c.id
        LEFT JOIN video_logs l ON v.id = l.video_id
        WHERE 1=1
      `;
        const params = [];

        if (startDate) {
            query += " AND v.created_at >= ?";
            params.push(startDate);
        }

        if (endDate) {
            query += " AND v.created_at <= ?";
            params.push(endDate);
        }

        if (channelId) {
            query += " AND v.channel_id = ?";
            params.push(channelId);
        }

        if (freelancerId) {
            // Filtramos pelo freelancer em qualquer um dos papéis
            query += ` AND (
          v.script_writer_id = ? OR 
          v.editor_id = ? OR 
          v.narrator_id = ? OR 
          v.thumb_maker_id = ?
        )`;
            params.push(freelancerId, freelancerId, freelancerId, freelancerId);
        }

        if (status) {
            const statusArray = status.split(',');
            query += ` AND v.status IN (${statusArray.map(() => '?').join(',')})`;
            params.push(...statusArray);
        }

        query += " GROUP BY v.id";

        const [reportData] = await connection.query(query, params);
        connection.release();

        // Formata o tempo médio para cada registro
        reportData.forEach(item => {
            const totalSeconds = Number(item.averageTimeInSeconds);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = Math.floor(totalSeconds % 60);
            item.averageTime = `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`;
        });

        // Se não houver dados, retorna 404
        if (!reportData.length) {
            return res.status(404).json({ message: 'Nenhum dado encontrado para exportação.' });
        }

        // Define os headers que serão usados nos arquivos exportados
        const headers = ["Canal", "Vídeo", "Status Atual", "Média de Tempo"];

        const exportsDir = path.join(__dirname, '../exports');
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }

        if (requestedFormat === 'pdf') {
            const doc = new PDFDocument({ margin: 30 });
            const filePath = path.join(exportsDir, 'report.pdf');
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            doc.fontSize(18).text('Relatório de Vídeos', { align: 'center' });
            doc.moveDown();

            reportData.forEach((data) => {
                doc.fontSize(12).text(`Canal: ${data.channelName || 'N/A'}`);
                doc.text(`Vídeo: ${data.videoTitle}`);
                doc.text(`Status Atual: ${data.status}`);
                doc.text(`Média de Tempo: ${data.averageTime}`);
                doc.text(`Data de Criação: ${data.createdAt}`);
                doc.moveDown();
            });

            doc.end();

            stream.on('finish', () => {
                res.download(filePath, 'report.pdf', (err) => {
                    if (err) throw err;
                    fs.unlinkSync(filePath);
                });
            });
        } else if (requestedFormat === 'excel') {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Relatório');

            worksheet.columns = [
                { header: 'Canal', key: 'channelName', width: 20 },
                { header: 'Vídeo', key: 'videoTitle', width: 30 },
                { header: 'Status Atual', key: 'status', width: 15 },
                { header: 'Média de Tempo', key: 'averageTime', width: 20 },
            ];

            // Define o header com formatação
            worksheet.getRow(1).font = { bold: true };
            worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
            worksheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF4F81BD' },
            };

            reportData.forEach((data) => {
                worksheet.addRow({
                    channelName: data.channelName,
                    videoTitle: data.videoTitle,
                    status: data.status,
                    averageTime: data.averageTime,
                });
            });

            worksheet.eachRow((row) => {
                row.eachCell((cell) => {
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' },
                    };
                });
            });

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
        res.status(500).json({ message: 'Erro ao exportar relatório.' });
    }
});



module.exports = router;
