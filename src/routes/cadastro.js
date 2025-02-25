const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt'); 
const router = express.Router();

router.post('/register', async (req, res) => {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
    }

    try {
        const connection = await req.db.getConnection();

        const [existingUser] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            connection.release();
            return res.status(409).json({ message: 'E-mail já cadastrado.' });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const [result] = await connection.query(
            'INSERT INTO users (name, email, password, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
            [name, email, hashedPassword, role || 'user']
        );

        connection.release();

        res.status(201).json({ message: 'Usuário cadastrado com sucesso.', userId: result.insertId });
    } catch (error) {
        console.error('Erro ao cadastrar usuário:', error);
        res.status(500).json({ message: 'Erro ao processar o cadastro.' });
    }
});

module.exports = router;