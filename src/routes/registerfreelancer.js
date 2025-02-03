const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const router = express.Router();

const secretKey = '3be6f7a5b4f2cba801809e063afd9ab5f29bba6c694a9f40ac4c0cef57803b43';

const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
        user: 'contato@conexaocode.com',
        pass: '#Henrique1312'
    }
});

router.post('/register-freelancer', async (req, res) => {
    const { name, email, role, phone } = req.body;

    if (!name || !email || !role || !phone) {
        return res.status(400).json({ message: 'Nome, e-mail, função e telefone são obrigatórios.' });
    }

    try {
        const connection = await req.db.getConnection();

        const [existingUser] = await connection.query('SELECT * FROM freelancers WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            connection.release();
            return res.status(409).json({ message: 'E-mail já cadastrado.' });
        }

        const generatedPassword = crypto.randomBytes(8).toString('hex');
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);

        await connection.query(
            'INSERT INTO freelancers (name, email, role, phone, password) VALUES (?, ?, ?, ?, ?)',
            [name, email, role, phone, hashedPassword]
        );
        connection.release();

        await transporter.sendMail({
            from: 'contato@conexaocode.com',
            to: email,
            subject: 'Bem-vindo ao sistema',
            html: `
                <div style="font-family: Poppins, sans-serif; padding: 20px; background-color: #f9f9f9; border: 1px solid #ddd; border-radius: 8px;">
                    <h2 style="color: #333;">Olá, ${name}</h2>
                    <p style="color: #555;">Sua conta foi criada com sucesso! Aqui estão seus detalhes de login:</p>
                    <p style="color: #555;"><strong>E-mail:</strong> ${email}</p>
                    <p style="color: #555;"><strong>Senha:</strong> ${generatedPassword}</p>
                    <p style="color: #555;">Recomendamos que você altere sua senha após o primeiro login.</p>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
                    <p style="color: #777; font-size: 12px;">Atenciosamente,</p>
                    <p style="color: #777; font-size: 12px;">Equipe do Sistema</p>
                </div>
            `
        });

        res.status(201).json({ message: 'Freelancer cadastrado com sucesso. A senha foi enviada por e-mail.' });
    } catch (error) {
        console.error('Erro ao registrar freelancer:', error);
        res.status(500).json({ message: 'Erro ao processar o cadastro.' });
    }
});


router.get('/freelancers', async (req, res) => {
    try {
        const connection = await req.db.getConnection();

        const [freelancers] = await connection.query(
            'SELECT id, name, email, role, created_at AS createdAt, updated_at FROM freelancers'
        );

        connection.release();

        res.json({
            message: 'Lista de freelancers obtida com sucesso.',
            data: freelancers
        });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({ message: 'Erro ao buscar a lista de freelancers.' });
    }
});

router.put('/freelancers/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, role } = req.body;

    if (!name || !email || !role) {
        return res.status(400).json({ message: 'Nome, e-mail e função são obrigatórios.' });
    }

    try {
        const connection = await req.db.getConnection();

        const [result] = await connection.query(
            'UPDATE freelancers SET name = ?, email = ?, role = ?, updated_at = NOW() WHERE id = ?',
            [name, email, role, id]
        );

        connection.release();

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Freelancer não encontrado.' });
        }

        res.json({ message: 'Freelancer atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro ao atualizar freelancer:', error);
        res.status(500).json({ message: 'Erro ao atualizar freelancer.' });
    }
});

router.delete('/freelancers/:id', async (req, res) => {
    const { id } = req.params;
    let connection;
    
    try {
        connection = await req.db.getConnection();
        await connection.beginTransaction();

        // Buscar a role do freelancer antes de deletá-lo
        const [freelancer] = await connection.query(
            "SELECT role FROM freelancers WHERE id = ?",
            [id]
        );

        if (freelancer.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Freelancer não encontrado.' });
        }

        const role = freelancer[0].role;
        let columnToUpdate = null;

        // Definir a coluna correta com base na role
        switch (role) {
            case 'roteirista':
                columnToUpdate = 'script_writer_id';
                break;
            case 'editor':
                columnToUpdate = 'editor_id';
                break;
            case 'narrador':
                columnToUpdate = 'narrator_id';
                break;
            case 'thumb maker':
                columnToUpdate = 'thumb_maker_id';
                break;
        }

        if (columnToUpdate) {
            await connection.query(
                `UPDATE videos SET ${columnToUpdate} = NULL WHERE ${columnToUpdate} = ?`,
                [id]
            );
        }

        // Excluir o freelancer da tabela freelancers
        const [result] = await connection.query(
            "DELETE FROM freelancers WHERE id = ?",
            [id]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            connection.release();
            return res.status(404).json({ message: 'Freelancer não encontrado.' });
        }

        await connection.commit();
        connection.release();
        res.json({ message: 'Freelancer deletado com sucesso.' });

    } catch (error) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error('Erro ao deletar freelancer:', error);
        res.status(500).json({ message: 'Erro ao deletar freelancer.' });
    }
});

  

module.exports = router;
