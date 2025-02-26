const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const { Pool: PgPool } = require('pg');
const config = require('../config');
const router = express.Router();

const secretKey = config.JWT_SECRET;
const codes = {};
const dbType = config.dbConfig.dbType;

// Configurar pools de conexão
const mysqlPool = mysql.createPool(config.dbConfig.mysql);
const pgPool = new PgPool(config.dbConfig.postgres);

// Middleware para obter conexão do banco correto
const getConnection = async () => {
  if (dbType === 'postgres') {
    return await pgPool.connect();
  }
  return await mysqlPool.getConnection();
};

// Função para executar consultas
const executeQuery = async (query, values, connection) => {
  if (dbType === 'postgres') {
    const result = await connection.query(query, values);
    return result.rows;
  }
  const [rows] = await connection.query(query, values);
  return rows;
};

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
  
    if (!email || !password) {
      return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }
  
    let connection;
    try {
      connection = await getConnection();
      let query, result;

      // Consulta usuários
      if (dbType === 'postgres') {
        query = 'SELECT * FROM users WHERE email = $1';
        result = await connection.query(query, [email]);
      } else {
        query = 'SELECT * FROM users WHERE email = ?';
        result = await connection.query(query, [email]);
      }
      let rows = dbType === 'postgres' ? result.rows : result[0];
      let isFreelancer = false;
      let userType = 'user';

      if (rows.length === 0) {
        // Consulta freelancers
        if (dbType === 'postgres') {
          query = 'SELECT * FROM freelancers WHERE email = $1';
          result = await connection.query(query, [email]);
        } else {
          query = 'SELECT * FROM freelancers WHERE email = ?';
          result = await connection.query(query, [email]);
        }
        rows = dbType === 'postgres' ? result.rows : result[0];
        isFreelancer = rows.length > 0;
        userType = 'freelancer';
      }

      if (rows.length === 0) {
        await connection.release();
        return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
      }

      const user = rows[0];
      const passwordMatch = await bcrypt.compare(password, user.password);
      
      if (!passwordMatch) {
        await connection.release();
        return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
      }

      // Verificar empresa para usuários normais
      let company = null;
      if (userType === 'user') {
        let companyQuery;
        if (dbType === 'postgres') {
          companyQuery = `
            SELECT c.id, c.active, c.subscription_end 
            FROM companies c 
            WHERE c.id = $1
          `;
        } else {
          companyQuery = `
            SELECT c.id, c.active, c.subscription_end 
            FROM companies c 
            WHERE c.id = ?
          `;
        }
        
        const companyResult = await connection.query(companyQuery, [user.company_id]);
        const companyRows = dbType === 'postgres' ? companyResult.rows : companyResult[0];

        if (companyRows.length === 0) {
          await connection.release();
          return res.status(403).json({ message: 'Usuário não vinculado a uma empresa válida.' });
        }

        company = companyRows[0];
        
        if (!company.active) {
          await connection.release();
          return res.status(403).json({ message: 'Empresa inativa.' });
        }

        if (new Date(company.subscription_end) < new Date()) {
          await connection.release();
          return res.status(403).json({ message: 'Assinatura da empresa expirada.' });
        }
      }

      await connection.release();

      const tokenPayload = {
        id: user.id,
        role: user.role,
        isFreelancer,
        companyId: user.company_id || null
      };

      const token = jwt.sign(tokenPayload, secretKey, { expiresIn: '1h' });

      res.json({
        message: 'Login bem-sucedido.',
        token,
        role: user.role,
        isFreelancer,
        id: user.id,
        companyId: user.company_id || null,
        companyActive: company ? company.active : true,
        subscriptionValid: company ? new Date(company.subscription_end) >= new Date() : true
      });
    } catch (error) {
      console.error('Erro no login:', error);
      if (connection) await connection.release();
      res.status(500).json({ message: 'Erro ao processar o login.' });
    }
});

router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'E-mail é obrigatório.' });
    }

    let connection;
    try {
      connection = await getConnection();
      let query;

      if (dbType === 'postgres') {
        query = `
          SELECT id, email, 'user' AS role FROM users WHERE email = $1
          UNION
          SELECT id, email, 'freelancer' AS role FROM freelancers WHERE email = $2
        `;
      } else {
        query = `
          SELECT id, email, 'user' AS role FROM users WHERE email = ?
          UNION
          SELECT id, email, 'freelancer' AS role FROM freelancers WHERE email = ?
        `;
      }

      const result = await connection.query(query, [email, email]);
      const rows = dbType === 'postgres' ? result.rows : result[0];
      
      if (rows.length === 0) {
        await connection.release();
        return res.status(404).json({ message: 'E-mail não encontrado.' });
      }

      const code = crypto.randomInt(100000, 999999).toString();
      codes[email] = code;

      const transporter = nodemailer.createTransport({
          host: 'smtp.hostinger.com',
          port: 587,
          auth: {
              user: 'contato@conexaocode.com',
              pass: '#Henrique1312'
          }
      });

      await transporter.sendMail({
          from: 'contato@conexaocode.com',
          to: email,
          subject: 'Código de Recuperação de Senha',
          text: `Seu código de recuperação é: ${code}`
      });

      await connection.release();
      res.json({ message: 'Código de recuperação enviado para o e-mail.' });
    } catch (error) {
      console.error('Erro ao enviar código:', error);
      if (connection) await connection.release();
      res.status(500).json({ message: 'Erro ao enviar código de recuperação.' });
    }
});

router.post('/verify-code', (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ message: 'E-mail e código são obrigatórios.' });
    }

    if (codes[email] && codes[email] === code) {
        return res.json({ message: 'Código verificado com sucesso.' });
    }

    return res.status(400).json({ message: 'Código inválido ou expirado.' });
});

router.post('/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
        return res.status(400).json({ message: 'E-mail, código e nova senha são obrigatórios.' });
    }

    if (!codes[email] || codes[email] !== code) {
        return res.status(400).json({ message: 'Código inválido ou expirado.' });
    }

    let connection;
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      connection = await getConnection();

      // Atualizar usuários
      let userQuery, freelancerQuery;
      if (dbType === 'postgres') {
        userQuery = 'UPDATE users SET password = $1 WHERE email = $2';
        freelancerQuery = 'UPDATE freelancers SET password = $1 WHERE email = $2';
      } else {
        userQuery = 'UPDATE users SET password = ? WHERE email = ?';
        freelancerQuery = 'UPDATE freelancers SET password = ? WHERE email = ?';
      }

      const [userUpdate] = await connection.query(userQuery, [hashedPassword, email]);
      const [freelancerUpdate] = await connection.query(freelancerQuery, [hashedPassword, email]);

      const affectedRows = dbType === 'postgres' 
        ? (userUpdate.rowCount + freelancerUpdate.rowCount)
        : (userUpdate[0].affectedRows + freelancerUpdate[0].affectedRows);

      if (affectedRows === 0) {
        await connection.release();
        return res.status(404).json({ message: 'E-mail não encontrado.' });
      }

      delete codes[email];
      await connection.release();
      res.json({ message: 'Senha redefinida com sucesso.' });
    } catch (error) {
      console.error('Erro ao redefinir senha:', error);
      if (connection) await connection.release();
      res.status(500).json({ message: 'Erro ao redefinir senha.' });
    }
});

module.exports = router;