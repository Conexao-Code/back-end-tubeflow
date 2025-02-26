const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const router = express.Router();

const secretKey = '3be6f7a5b4f2cba801809e063afd9ab5f29bba6c694a9f40ac4c0cef57803b43';
const codes = {}; 

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
  
    if (!email || !password) {
      return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
    }
  
    try {
      const connection = await req.db.getConnection();
  
      let [rows] = await connection.query('SELECT * FROM users WHERE email = ?', [email]);
      let isFreelancer = false;
      let userType = 'user';

      if (rows.length === 0) {
        [rows] = await connection.query('SELECT * FROM freelancers WHERE email = ?', [email]);
        isFreelancer = rows.length > 0;
        userType = 'freelancer';
      }
  
      if (rows.length === 0) {
        connection.release();
        return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
      }
  
      const user = rows[0];
      const passwordMatch = await bcrypt.compare(password, user.password);
      
      if (!passwordMatch) {
        connection.release();
        return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
      }

      // Verificar empresa apenas para usuários normais
      let company = null;
      if (userType === 'user') {
        const [companyRows] = await connection.query(`
          SELECT c.id, c.active, c.subscription_end 
          FROM companies c 
          WHERE c.id = ?
        `, [user.company_id]);

        if (companyRows.length === 0) {
          connection.release();
          return res.status(403).json({ message: 'Usuário não vinculado a uma empresa válida.' });
        }

        company = companyRows[0];
        
        if (!company.active) {
          connection.release();
          return res.status(403).json({ message: 'Empresa inativa.' });
        }

        if (new Date(company.subscription_end) < new Date()) {
          connection.release();
          return res.status(403).json({ message: 'Assinatura da empresa expirada.' });
        }
      }

      connection.release();
  
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
      res.status(500).json({ message: 'Erro ao processar o login.' });
    }
});

router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'E-mail é obrigatório.' });
    }

    try {
        const connection = await req.db.getConnection();

        const [rows] = await connection.query(`
            SELECT id, email, 'user' AS role FROM users WHERE email = ?
            UNION
            SELECT id, email, 'freelancer' AS role FROM freelancers WHERE email = ?
        `, [email, email]);
        connection.release();

        if (rows.length === 0) {
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

        res.json({ message: 'Código de recuperação enviado para o e-mail.' });
    } catch (error) {
        console.error('Erro ao enviar código:', error);
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

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const connection = await req.db.getConnection();

        const [userUpdate] = await connection.query(
            'UPDATE users SET password = ? WHERE email = ?',
            [hashedPassword, email]
        );
        const [freelancerUpdate] = await connection.query(
            'UPDATE freelancers SET password = ? WHERE email = ?',
            [hashedPassword, email]
        );

        connection.release();

        if (userUpdate.affectedRows === 0 && freelancerUpdate.affectedRows === 0) {
            return res.status(404).json({ message: 'E-mail não encontrado.' });
        }

        delete codes[email];

        res.json({ message: 'Senha redefinida com sucesso.' });
    } catch (error) {
        console.error('Erro ao redefinir senha:', error);
        res.status(500).json({ message: 'Erro ao redefinir senha.' });
    }
});

module.exports = router;
