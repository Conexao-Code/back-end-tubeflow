const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { Parser } = require('json2csv');

router.get('/channels', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const [channels] = await connection.query('SELECT id, name FROM channels');
        connection.release();

        res.json({ channels });
    } catch (error) {
        console.error('Erro ao buscar canais:', error);
        res.status(500).json({ message: 'Erro ao buscar canais.' });
    }
});

router.get('/freelancers', async (req, res) => {
    try {
        const connection = await req.db.getConnection();
        const [freelancers] = await connection.query('SELECT id, name FROM freelancers');
        connection.release();

        res.json({ data: freelancers });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({ message: 'Erro ao buscar freelancers.' });
    }
});

router.get('/logs', async (req, res) => {
    try {
        const { page = 1, limit = 10, startDate, endDate, channelId, freelancerId } = req.query;
        const offset = (page - 1) * limit;
        const connection = await req.db.getConnection();

        let query = `
            SELECT 
                l.id, 
                l.video_id AS videoId, 
                v.title AS videoTitle, 
                c.name AS channelName, 
                f.name AS freelancerName, 
                l.from_status AS previousStatus, 
                l.to_status AS newStatus, 
                l.timestamp 
            FROM video_logs l
            LEFT JOIN videos v ON l.video_id = v.id
            LEFT JOIN channels c ON v.channel_id = c.id
            LEFT JOIN freelancers f ON l.user_id = f.id
            WHERE 1=1
        `;

        const params = [];

        if (startDate) {
            query += ' AND l.timestamp >= ?';
            params.push(startDate);
        }

        if (endDate) {
            query += ' AND l.timestamp <= ?';
            params.push(endDate);
        }

        if (channelId) {
            query += ' AND v.channel_id = ?';
            params.push(channelId);
        }

        if (freelancerId) {
            query += ' AND l.user_id = ?';
            params.push(freelancerId);
        }

        query += ' ORDER BY l.timestamp DESC LIMIT ? OFFSET ?';
        params.push(Number(limit), Number(offset));

        const [logs] = await connection.query(query, params);

        const [[{ total }]] = await connection.query(
            `SELECT COUNT(*) AS total 
             FROM video_logs l
             LEFT JOIN videos v ON l.video_id = v.id
             WHERE 1=1` +
            (startDate ? ' AND l.timestamp >= ?' : '') +
            (endDate ? ' AND l.timestamp <= ?' : '') +
            (channelId ? ' AND v.channel_id = ?' : '') +
            (freelancerId ? ' AND l.user_id = ?' : ''),
            params.slice(0, -2)
        );
        

        connection.release();

        res.json({ logs, total });
    } catch (error) {
        console.error('Erro ao buscar logs:', error);
        res.status(500).json({ message: 'Erro ao buscar logs.' });
    }
});

router.get('/stats', async (req, res) => {
    try {
      const { startDate, endDate, channelId, freelancerId } = req.query;
      const connection = await req.db.getConnection();
  
      let query = `
        SELECT 
          f.id,
          f.name,
          COALESCE(SUM(logs.tasksCompleted), 0) AS tasksCompleted,
          COALESCE(AVG(logs.totalDuration), 0) AS averageTime,
          SUM(IF(COALESCE(logs.totalDuration, 0) > 86400, 1, 0)) AS delays
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
            SUM(duration) AS totalDuration,
            SUM(
              CASE 
                WHEN to_status IN ('Roteiro_Concluído', 'Narração_Concluída', 'Edição_Concluído', 'Thumbnail_Concluída')
                THEN 1 ELSE 0
              END
            ) AS tasksCompleted
          FROM video_logs
          WHERE is_user = 0
          GROUP BY video_id, user_id
        ) logs ON v.id = logs.video_id AND f.id = logs.user_id
        WHERE 1=1
      `;
  
      const params = [];
  
      if (startDate) {
        query += ' AND v.created_at >= ?';
        params.push(startDate);
      }
  
      if (endDate) {
        query += ' AND v.created_at <= ?';
        params.push(endDate);
      }
  
      if (channelId) {
        query += ' AND v.channel_id = ?';
        params.push(channelId);
      }
  
      if (freelancerId) {
        query += ' AND f.id = ?';
        params.push(freelancerId);
      }
  
      query += ' GROUP BY f.id';
  
      const [stats] = await connection.query(query, params);
  
      const formattedStats = stats.map(stat => {
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
  
      connection.release();
      res.json({ stats: formattedStats });
    } catch (error) {
      console.error('Erro ao buscar estatísticas:', error);
      res.status(500).json({ message: 'Erro ao buscar estatísticas.' });
    }
  });

router.get('/export', async (req, res) => {
    try {
        const { startDate, endDate, channelId, freelancerId, type, format = 'csv' } = req.query;
        const connection = await req.db.getConnection();

        let query;
        let filename;
        let headers;

        if (type === 'logs') {
            query = `
                SELECT 
                    l.timestamp AS "Data/Hora", 
                    v.title AS "Título do Vídeo", 
                    c.name AS "Nome do Canal", 
                    f.name AS "Nome do Freelancer", 
                    l.from_status AS "Status Anterior", 
                    l.to_status AS "Status Atual"
                FROM video_logs l
                LEFT JOIN videos v ON l.video_id = v.id
                LEFT JOIN channels c ON v.channel_id = c.id
                LEFT JOIN freelancers f ON l.user_id = f.id
                WHERE 1=1
            `;

            headers = ["Data/Hora", "Título do Vídeo", "Nome do Canal", "Nome do Freelancer", "Status Anterior", "Status Atual"];
            filename = 'logs';
        } else if (type === 'stats') {
            query = `
                SELECT 
                    f.name AS "Nome do Freelancer", 
                    COUNT(v.id) AS "Tarefas Completadas", 
                    ROUND(COALESCE(AVG(logs.totalDuration), 0), 2) AS "Tempo Médio (s)", 
                    SUM(IF(COALESCE(logs.totalDuration, 0) > 86400, 1, 0)) AS "Atrasos"
                FROM freelancers f
                LEFT JOIN videos v ON v.freelancer_id = f.id
                LEFT JOIN (
                    SELECT video_id, SUM(duration) AS totalDuration
                    FROM video_logs
                    GROUP BY video_id
                ) logs ON v.id = logs.video_id
                WHERE 1=1
                GROUP BY f.id
            `;

            headers = ["Nome do Freelancer", "Tarefas Completadas", "Tempo Médio (s)", "Atrasos"];
            filename = 'stats';
        } else {
            res.status(400).json({ message: 'Tipo de exportação inválido.' });
            return;
        }

        const params = [];

        if (startDate) {
            query += ' AND v.created_at >= ?';
            params.push(startDate);
        }

        if (endDate) {
            query += ' AND v.created_at <= ?';
            params.push(endDate);
        }

        if (channelId) {
            query += ' AND v.channel_id = ?';
            params.push(channelId);
        }

        if (freelancerId) {
            query += ' AND v.freelancer_id = ?';
            params.push(freelancerId);
        }

        const [data] = await connection.query(query, params);
        connection.release();

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
        console.error('Erro ao exportar dados:', error);
        res.status(500).json({ message: 'Erro ao exportar dados.' });
    }
});

module.exports = router;
