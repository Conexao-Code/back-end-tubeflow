const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { Parser } = require('json2csv');
const { Pool } = require('pg');
const config = require('../config');
const ExcelJS = require('exceljs');

const pool = new Pool(config.dbConfig.postgres);

router.use((req, res, next) => {
  req.db = pool;
  next();
});

router.get('/channels2', async (req, res) => {
    let client;
    try {
        const { companyId } = req.query;
        client = await req.db.connect();
        const result = await client.query(
            'SELECT id, name FROM channels WHERE company_id = $1',
            [companyId]
        );
        res.json({ channels: result.rows });
    } catch (error) {
        console.error('Erro ao buscar canais:', error);
        res.status(500).json({ message: 'Erro ao buscar canais.' });
    } finally {
        if (client) client.release();
    }
});

router.get('/freelancers3', async (req, res) => {
    let client;
    try {
        const { companyId } = req.query;
        
        if (!companyId) {
            return res.status(400).json({ message: "Company ID é obrigatório." });
        }

        client = await req.db.connect();
        const result = await client.query(
            'SELECT id, name FROM freelancers WHERE company_id = $1',
            [companyId]
        );
        
        res.json({ data: result.rows });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({ message: 'Erro ao buscar freelancers.' });
    } finally {
        if (client) client.release();
    }
});

router.get('/logs2', async (req, res) => {
    let client;
    let query; // Declarado fora do bloco try para acesso no catch
    try {
        const { 
            page = 1, 
            limit = 10, 
            startDate, 
            endDate, 
            channelId, 
            freelancerId,
            companyId
        } = req.query;

        if (!companyId) {
            return res.status(400).json({ 
                message: "Company ID é obrigatório",
                details: "Parâmetro 'companyId' não fornecido na query string"
            });
        }

        client = await req.db.connect();
        
        let queryParams = [companyId];
        query = `
            SELECT 
                l.id, 
                l.video_id AS "videoId", 
                v.title AS "videoTitle", 
                c.name AS "channelName", 
                f.name AS "freelancerName", 
                l.from_status AS "previousStatus",
                l.to_status AS "newStatus",       
                l.created_at AS timestamp
            FROM video_logs l
            LEFT JOIN videos v ON l.video_id = v.id
            LEFT JOIN channels c ON v.channel_id = c.id
            LEFT JOIN freelancers f ON l.user_id = f.id
            WHERE v.company_id = $1 and v.is_user = false
        `;

        const addCondition = (value, column, operator = '>=') => {
            if (value) {
                queryParams.push(value);
                query += ` AND ${column} ${operator} $${queryParams.length}`;
            }
        };

        addCondition(startDate, 'l.created_at');
        addCondition(endDate, 'l.created_at', '<=');
        addCondition(channelId, 'v.channel_id');
        addCondition(freelancerId, 'l.user_id');

        const offset = (page - 1) * limit;
        query += `
            ORDER BY l.created_at DESC 
            LIMIT $${queryParams.length + 1} 
            OFFSET $${queryParams.length + 2}
        `;
        queryParams.push(Number(limit), Number(offset));

        const logsResult = await client.query(query, queryParams);

        let countQuery = `
            SELECT COUNT(*) AS total 
            FROM video_logs l
            LEFT JOIN videos v ON l.video_id = v.id
            WHERE v.company_id = $1
        `;
        const countParams = [companyId];

        const addCountCondition = (value, column, operator = '>=') => {
            if (value) {
                countParams.push(value);
                countQuery += ` AND ${column} ${operator} $${countParams.length}`;
            }
        };

        addCountCondition(startDate, 'l.created_at');
        addCountCondition(endDate, 'l.created_at', '<=');
        addCountCondition(channelId, 'v.channel_id');
        addCountCondition(freelancerId, 'l.user_id');

        const countResult = await client.query(countQuery, countParams);
        const total = countResult.rows[0]?.total || 0;

        res.json({ 
            logs: logsResult.rows,
            total: parseInt(total, 10)
        });

    } catch (error) {
        console.error('Erro detalhado:', {
            message: error.message,
            query: error.query || query, // Agora query está definida
            parameters: error.parameters || queryParams
        });

        res.status(500).json({ 
            message: 'Erro ao buscar logs',
            error: {
                code: error.code || 'DB_ERROR',
                detail: error.message,
                hint: 'Verifique os parâmetros de filtragem e datas',
                timestamp: new Date().toISOString()
            }
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/stats', async (req, res) => {
    let client;
    let query; // Declarado fora do bloco try para acesso no catch
    try {
        const { 
            startDate, 
            endDate, 
            channelId, 
            freelancerId,
            companyId
        } = req.query;

        if (!companyId) {
            return res.status(400).json({
                message: "Parâmetro obrigatório faltando",
                details: "O companyId é requerido na query string"
            });
        }

        client = await req.db.connect();

        let queryParams = [companyId];
        query = `
            SELECT 
                f.id,
                f.name,
                COALESCE(SUM(logs.tasksCompleted), 0) AS "tasksCompleted",
                COALESCE(AVG(logs.totalDuration), 0) AS "averageTime",
                SUM( (COALESCE(logs.totalDuration, 0) > 86400)::INT ) AS delays
            FROM freelancers f
            LEFT JOIN (
                SELECT 
                    freelancer_id,
                    video_id
                FROM (
                    SELECT script_writer_id AS freelancer_id, id AS video_id FROM videos
                    UNION ALL
                    SELECT editor_id, id AS video_id FROM videos
                    UNION ALL
                    SELECT narrator_id, id AS video_id FROM videos
                    UNION ALL
                    SELECT thumb_maker_id, id AS video_id FROM videos
                ) AS combined_roles
            ) vr ON f.id = vr.freelancer_id
            LEFT JOIN videos v ON vr.video_id = v.id
            LEFT JOIN (
                SELECT 
                    video_id,
                    user_id,
                    SUM(duration_seconds) AS totalDuration,
                    tasksCompleted
                FROM (
                    SELECT 
                        video_id,
                        user_id,
                        SUM(
                            CASE 
                                WHEN (to_status = 'Roteiro_Concluído' AND prev_status = 'Roteiro_Em_Andamento') OR
                                     (to_status = 'Narração_Concluída' AND prev_status = 'Narração_Em_Andamento') OR
                                     (to_status = 'Edição_Concluído' AND prev_status = 'Edição_Em_Andamento') OR
                                     (to_status = 'Thumbnail_Concluída' AND prev_status = 'Thumbnail_Em_Andamento')
                                THEN EXTRACT(EPOCH FROM (created_at - prev_created_at))
                                ELSE 0
                            END
                        ) AS duration_seconds,
                        SUM(
                            CASE 
                                WHEN to_status IN ('Roteiro_Concluído', 'Narração_Concluída', 'Edição_Concluído', 'Thumbnail_Concluída')
                                THEN 1 ELSE 0
                            END
                        ) AS tasksCompleted
                    FROM (
                        SELECT 
                            video_id,
                            user_id,
                            to_status,
                            created_at,
                            LAG(to_status) OVER (PARTITION BY video_id, user_id ORDER BY created_at) AS prev_status,
                            LAG(created_at) OVER (PARTITION BY video_id, user_id ORDER BY created_at) AS prev_created_at
                        FROM video_logs
                        WHERE is_user = FALSE
                    ) AS log_pairs
                    WHERE to_status IN ('Roteiro_Concluído', 'Narração_Concluída', 'Edição_Concluído', 'Thumbnail_Concluída')
                    GROUP BY video_id, user_id
                ) AS calculated_logs
                GROUP BY video_id, user_id, tasksCompleted
            ) logs ON v.id = logs.video_id AND f.id = logs.user_id
            WHERE f.company_id = $1
        `;

        const addCondition = (value, column, operator = '>=') => {
            if (value) {
                queryParams.push(value);
                query += ` AND ${column} ${operator} $${queryParams.length}`;
            }
        };

        addCondition(startDate, 'v.created_at');
        addCondition(endDate, 'v.created_at', '<=');
        addCondition(channelId, 'v.channel_id');
        addCondition(freelancerId, 'f.id');

        query += ' GROUP BY f.id';

        const statsResult = await client.query(query, queryParams);

        const formattedStats = statsResult.rows.map(stat => {
            const totalSeconds = Math.round(stat.averageTime);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            return {
                ...stat,
                averageTimeFormatted: `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s`
            };
        });

        res.json({ stats: formattedStats });

    } catch (error) {
        console.error('Erro detalhado:', {
            message: error.message,
            stack: error.stack,
            query: error.query || query, // Agora query está definida
            parameters: error.parameters || queryParams
        });

        res.status(500).json({
            message: 'Erro ao buscar estatísticas',
            error: {
                code: error.code || 'POSTGRES_ERROR',
                detail: error.detail || error.message,
                hint: error.hint || 'Verifique os parâmetros de filtro e datas',
                timestamp: new Date().toISOString(),
                failedQuery: error.query ? {
                    text: error.query.text,
                    values: error.query.values
                } : null
            }
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/export', async (req, res) => {
    let client;
    let query; // Declarado fora do bloco try para acesso no catch
    try {
        const { 
            startDate, 
            endDate, 
            channelId, 
            freelancerId, 
            type, 
            format = 'csv',
            companyId
        } = req.query;

        client = await req.db.connect();

        let queryParams = [companyId];
        let filename;
        let headers;

        if (type === 'logs') {
            query = `
                SELECT 
                    l.created_at AS "Data/Hora", 
                    v.title AS "Título do Vídeo", 
                    c.name AS "Nome do Canal", 
                    f.name AS "Nome do Freelancer", 
                    l.from_status AS "Status Anterior",  -- Corrigido
                    l.to_status AS "Status Atual"        -- Corrigido
                FROM video_logs l
                LEFT JOIN videos v ON l.video_id = v.id
                LEFT JOIN channels c ON v.channel_id = c.id
                LEFT JOIN freelancers f ON l.user_id = f.id
                WHERE v.company_id = $1
            `;

            headers = ["Data/Hora", "Título do Vídeo", "Nome do Canal", "Nome do Freelancer", "Status Anterior", "Status Atual"];
            filename = 'logs';
        } else if (type === 'stats') {
            query = `
                SELECT 
                    f.name AS "Nome do Freelancer", 
                    COUNT(v.id) AS "Tarefas Completadas", 
                    ROUND(COALESCE(AVG(logs.totalDuration), 0) AS "Tempo Médio (s)", 
                    SUM(COALESCE(logs.totalDuration, 0) > 86400)::INT AS "Atrasos"
                FROM freelancers f
                LEFT JOIN videos v ON v.company_id = f.company_id
                LEFT JOIN (
                    SELECT 
                        video_id,
                        user_id,
                        SUM(duration_seconds) AS totalDuration
                    FROM (
                        SELECT 
                            video_id,
                            user_id,
                            SUM(
                                CASE 
                                    WHEN (to_status = 'Roteiro_Concluído' AND prev_status = 'Roteiro_Em_Andamento') OR
                                         (to_status = 'Narração_Concluída' AND prev_status = 'Narração_Em_Andamento') OR
                                         (to_status = 'Edição_Concluído' AND prev_status = 'Edição_Em_Andamento') OR
                                         (to_status = 'Thumbnail_Concluída' AND prev_status = 'Thumbnail_Em_Andamento')
                                    THEN EXTRACT(EPOCH FROM (created_at - prev_created_at))
                                    ELSE 0
                                END
                            ) AS duration_seconds
                        FROM (
                            SELECT 
                                video_id,
                                user_id,
                                to_status,
                                created_at,
                                LAG(to_status) OVER (PARTITION BY video_id, user_id ORDER BY created_at) AS prev_status,
                                LAG(created_at) OVER (PARTITION BY video_id, user_id ORDER BY created_at) AS prev_created_at
                            FROM video_logs
                        ) AS log_pairs
                        WHERE to_status IN ('Roteiro_Concluído', 'Narração_Concluída', 'Edição_Concluído', 'Thumbnail_Concluída')
                        GROUP BY video_id, user_id
                    ) AS calculated_durations
                    GROUP BY video_id, user_id
                ) logs ON v.id = logs.video_id
                WHERE f.company_id = $1
                GROUP BY f.id
            `;

            headers = ["Nome do Freelancer", "Tarefas Completadas", "Tempo Médio (s)", "Atrasos"];
            filename = 'stats';
        } else {
            res.status(400).json({ message: 'Tipo de exportação inválido.' });
            return;
        }

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
            queryParams.push(freelancerId);
            query += ` AND f.id = $${queryParams.length}`;
        }

        const result = await client.query(query, queryParams);
        const data = result.rows;

        if (format === 'csv') {
            const json2csvParser = new Parser({ fields: headers });
            const csv = json2csvParser.parse(data);

            const filePath = path.join(__dirname, `../exports/${filename}.csv`);
            fs.writeFileSync(filePath, csv);

            res.download(filePath, `${filename}.csv`, (err) => {
                if (err) throw err;
                fs.unlinkSync(filePath);
            });
        } else if (format === 'excel') {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet(filename);

            sheet.addRow(headers).eachCell((cell) => {
                cell.font = { bold: true };
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFCCCCCC' }
                };
            });

            data.forEach((row) => {
                sheet.addRow(Object.values(row));
            });

            sheet.columns.forEach((column) => {
                column.width = Math.max(15, ...column.values.map((val) => (val ? val.toString().length : 0)) + 2);
            });

            const filePath = path.join(__dirname, `../exports/${filename}.xlsx`);
            await workbook.xlsx.writeFile(filePath);

            res.download(filePath, `${filename}.xlsx`, (err) => {
                if (err) throw err;
                fs.unlinkSync(filePath);
            });
        } else {
            res.status(400).json({ message: 'Formato inválido. Use "csv" ou "excel".' });
        }
    } catch (error) {
        console.error('Erro ao exportar dados:', {
            message: error.message,
            query: error.query || query,
            parameters: error.parameters || queryParams
        });
        res.status(500).json({ message: 'Erro ao exportar dados.' });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;