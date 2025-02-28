const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const config = require('../config');
const router = express.Router();

const pool = new Pool(config.dbConfig.postgres);

router.use((req, res, next) => {
  req.db = pool;
  next();
});

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
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ message: 'Company ID é obrigatório.' });
    }

    if (!name || !email || !role || !phone) {
        return res.status(400).json({ message: 'Nome, e-mail, função e telefone são obrigatórios.' });
    }

    try {
        client = await req.db.connect();
        
        const checkResult = await client.query(
            'SELECT * FROM freelancers WHERE email = $1 AND company_id = $2', 
            [email, companyId]
        );

        if (checkResult.rows.length > 0) {
            return res.status(409).json({ message: 'E-mail já cadastrado.' });
        }

        const generatedPassword = crypto.randomBytes(8).toString('hex');
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);

        await client.query(
            `INSERT INTO freelancers 
                (name, email, role, phone, password, company_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            [name, email, role, phone, hashedPassword, companyId]
        );

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
        res.status(500).json({ 
            message: 'Erro ao processar o cadastro.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.get('/freelancers', async (req, res) => {
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ message: 'Company ID é obrigatório.' });
    }

    try {
        client = await req.db.connect();
        
        const result = await client.query(
            `SELECT 
                id, 
                name, 
                email, 
                role, 
                phone, 
                created_at AS "createdAt", 
                updated_at AS "updatedAt" 
             FROM freelancers
             WHERE company_id = $1`,
            [companyId]
        );

        res.json({
            message: 'Lista de freelancers obtida com sucesso.',
            data: result.rows
        });
    } catch (error) {
        console.error('Erro ao buscar freelancers:', error);
        res.status(500).json({ 
            message: 'Erro ao buscar a lista de freelancers.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.put('/freelancers/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, role } = req.body;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ message: 'Company ID é obrigatório.' });
    }

    if (!name || !email || !role) {
        return res.status(400).json({ message: 'Nome, e-mail e função são obrigatórios.' });
    }

    try {
        client = await req.db.connect();
        
        const result = await client.query(
            `UPDATE freelancers 
             SET 
                name = $1, 
                email = $2, 
                role = $3, 
                updated_at = NOW() 
             WHERE id = $4 AND company_id = $5
             RETURNING *`,
            [name, email, role, id, companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Freelancer não encontrado.' });
        }

        res.json({ 
            message: 'Freelancer atualizado com sucesso.',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Erro ao atualizar freelancer:', error);
        res.status(500).json({ 
            message: 'Erro ao atualizar freelancer.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

router.delete('/freelancers/:id', async (req, res) => {
    const { id } = req.params;
    const companyId = req.headers['company-id'];
    let client;
    
    if (!companyId) {
        return res.status(400).json({ message: 'Company ID é obrigatório.' });
    }

    try {
        client = await req.db.connect();
        await client.query('BEGIN');

        const freelancerResult = await client.query(
            "SELECT role FROM freelancers WHERE id = $1 AND company_id = $2",
            [id, companyId]
        );

        if (freelancerResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Freelancer não encontrado.' });
        }

        const role = freelancerResult.rows[0].role;
        let columnToUpdate = null;

        switch (role.toLowerCase()) {
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
            await client.query(
                `UPDATE videos 
                 SET ${columnToUpdate} = NULL 
                 WHERE ${columnToUpdate} = $1 AND company_id = $2`,
                [id, companyId]
            );
        }

        const deleteResult = await client.query(
            "DELETE FROM freelancers WHERE id = $1 AND company_id = $2",
            [id, companyId]
        );

        if (deleteResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Freelancer não encontrado.' });
        }

        await client.query('COMMIT');
        res.json({ message: 'Freelancer deletado com sucesso.' });

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Erro ao deletar freelancer:', error);
        res.status(500).json({ 
            message: 'Erro ao deletar freelancer.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;