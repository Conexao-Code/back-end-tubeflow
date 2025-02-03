const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const router = express.Router();


router.get('/administrators', async (req, res) => {
    let connection
    try {
        connection = await req.db.getConnection()
        const [rows] = await connection.query(
            "SELECT id, name, email, created_at AS createdAt FROM users WHERE role = 'admin'"
        )
        connection.release()
        res.json({ data: rows })
    } catch (error) {
        if (connection) connection.release()
        res.status(500).json({ message: 'Erro ao buscar administradores.' })
    }
})


function generateRandomPassword(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let password = ''
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return password
}

const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 587,
    auth: {
        user: 'contato@conexaocode.com',
        pass: '#Henrique1312'
    }
});

router.post('/register-administrator', async (req, res) => {
    const { name, email } = req.body
    const randomPassword = generateRandomPassword(8)
    let connection
    try {
      connection = await req.db.getConnection()
      const hashedPassword = await bcrypt.hash(randomPassword, 10)
      await connection.query(
        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')",
        [name, email, hashedPassword]
      )
      connection.release()
  
      const mailOptions = {
        from: '"Equipe TubeFlow" <contato@conexaocode.com>',
        to: email,
        subject: 'Cadastro de Administrador',
        html: `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>Cadastro de Administrador</title>
            </head>
            <body style="margin: 0; padding: 0; background-color: #F3F4F6;">
              <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="border-collapse: collapse;">
                <tr>
                  <td align="center" bgcolor="#1D4ED8" style="padding: 40px 0; color: #ffffff; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 24px;">
                    <strong>TubeFlow</strong>
                  </td>
                </tr>
                <tr>
                  <td bgcolor="#ffffff" style="padding: 40px 30px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 16px; line-height: 24px; color: #333333;">
                    <p style="margin: 0;">Olá ${name},</p>
                    <p style="margin: 20px 0 0 0;">Seu cadastro como administrador foi realizado com sucesso.</p>
                    <p style="margin: 20px 0 0 0;">Segue sua senha de acesso: <strong>${randomPassword}</strong></p>
                    <p style="margin: 20px 0 0 0;">Por favor, altere sua senha após o primeiro acesso.</p>
                  </td>
                </tr>
                <tr>
                  <td bgcolor="#ffffff" style="padding: 0 30px 40px 30px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 20px; color: #666666;">
                    <p style="margin: 0;">Atenciosamente,<br>Equipe TubeFlow</p>
                  </td>
                </tr>
                <tr>
                  <td bgcolor="#F3F4F6" style="padding: 20px 30px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 12px; color: #999999;" align="center">
                    <p style="margin: 0;">&copy; 2025 TubeFlow. Todos os direitos reservados.</p>
                  </td>
                </tr>
              </table>
            </body>
          </html>
        `
      }
  
      await transporter.sendMail(mailOptions)
      res.status(201).json({ message: 'Administrador cadastrado com sucesso. A senha foi enviada para o e-mail cadastrado.' })
    } catch (error) {
      if (connection) connection.release()
      console.error('Erro ao cadastrar administrador:', error)
      res.status(500).json({ message: 'Erro ao cadastrar administrador.' })
    }
  })

router.put('/administrators/:id', async (req, res) => {
    const { id } = req.params
    const { name, email } = req.body
    let connection
    try {
        connection = await req.db.getConnection()
        const [result] = await connection.query(
            "UPDATE users SET name = ?, email = ? WHERE id = ? AND role = 'admin'",
            [name, email, id]
        )
        connection.release()
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Administrador não encontrado.' })
        }
        res.json({ message: 'Administrador atualizado com sucesso.' })
    } catch (error) {
        if (connection) connection.release()
        res.status(500).json({ message: 'Erro ao atualizar administrador.' })
    }
})

router.delete('/administrators/:id', async (req, res) => {
    const { id } = req.params
    let connection
    try {
        connection = await req.db.getConnection()
        const [result] = await connection.query(
            "DELETE FROM users WHERE id = ? AND role = 'admin'",
            [id]
        )
        connection.release()
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Administrador não encontrado.' })
        }
        res.json({ message: 'Administrador excluído com sucesso.' })
    } catch (error) {
        if (connection) connection.release()
        res.status(500).json({ message: 'Erro ao excluir administrador.' })
    }
})

module.exports = router;