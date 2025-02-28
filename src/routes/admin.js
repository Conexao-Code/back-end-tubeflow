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

const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
        user: 'contato@conexaocode.com',
        pass: '#Henrique1312'
    }
});

function generateRandomPassword(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    return Array.from(crypto.randomFillSync(new Uint32Array(length)))
        .map((x) => chars[x % chars.length])
        .join('');
}

router.get('/administrators', async (req, res) => {
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    try {
        client = await req.db.connect();
        const result = await client.query(
            `SELECT 
                id, 
                name, 
                email, 
                created_at AS "createdAt",
                updated_at AS "updatedAt" 
             FROM users 
             WHERE role = 'admin' 
             AND company_id = $1`,
            [companyId]
        );

        res.json({ 
            data: result.rows,
            count: result.rowCount
        });
    } catch (error) {
        console.error('Erro ao buscar administradores:', {
            error: error.message,
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao buscar administradores.',
            errorCode: 'ADMIN_FETCH_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

router.post('/register-administrator', async (req, res) => {
    const { name, email } = req.body;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    if (!name || !email) {
        return res.status(400).json({ 
            message: 'Nome e e-mail são obrigatórios.',
            errorCode: 'MISSING_REQUIRED_FIELDS'
        });
    }

    try {
        client = await req.db.connect();
        await client.query('BEGIN');

        // Verificar e-mail existente na empresa
        const emailCheck = await client.query(
            `SELECT id FROM users 
             WHERE email = $1 
             AND company_id = $2`,
            [email, companyId]
        );

        if (emailCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ 
                message: 'E-mail já cadastrado para esta empresa.',
                errorCode: 'DUPLICATE_EMAIL'
            });
        }

        // Gerar senha segura
        const randomPassword = generateRandomPassword();
        const hashedPassword = await bcrypt.hash(randomPassword, 12);

        // Inserir novo administrador
        const insertResult = await client.query(
            `INSERT INTO users (
                name, 
                email, 
                password, 
                role, 
                company_id, 
                created_at, 
                updated_at
            ) VALUES ($1, $2, $3, 'admin', $4, NOW(), NOW())
            RETURNING id, created_at`,
            [name, email, hashedPassword, companyId]
        );

        // Enviar e-mail
        const mailOptions = {
            from: '"Equipe TubeFlow" <contato@conexaocode.com>',
            to: email,
            subject: 'Cadastro de Administrador - TubeFlow',
            html: `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #1D4ED8; font-size: 24px; margin-bottom: 10px;">Cadastro Realizado</h1>
                        <p style="color: #4b5563;">Olá ${name}, seu acesso como administrador foi configurado com sucesso.</p>
                    </div>

                    <div style="background-color: #f8fafc; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                        <h2 style="color: #1e3a8a; font-size: 18px; margin-bottom: 15px;">Credenciais de Acesso</h2>
                        <div style="margin-bottom: 10px;">
                            <span style="color: #4b5563; font-weight: 500;">E-mail:</span>
                            <span style="color: #1e3a8a;">${email}</span>
                        </div>
                        <div style="margin-bottom: 15px;">
                            <span style="color: #4b5563; font-weight: 500;">Senha Temporária:</span>
                            <span style="color: #1e3a8a; font-family: monospace;">${randomPassword}</span>
                        </div>
                        <p style="color: #6b7280; font-size: 14px;">
                            Recomendamos que altere sua senha após o primeiro login.
                        </p>
                    </div>

                    <div style="text-align: center; color: #6b7280; font-size: 14px;">
                        <p>Este é um e-mail automático, por favor não responda.</p>
                        <p style="margin-top: 20px;">
                            <a href="https://conexaocode.com" style="color: #3b82f6; text-decoration: none;">Suporte Técnico</a> | 
                            <a href="https://conexaocode.com/privacidade" style="color: #3b82f6; text-decoration: none;">Política de Privacidade</a>
                        </p>
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        await client.query('COMMIT');

        res.status(201).json({ 
            message: 'Administrador cadastrado com sucesso.',
            data: {
                id: insertResult.rows[0].id,
                createdAt: insertResult.rows[0].created_at
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao cadastrar administrador:', {
            error: error.message,
            params: { name, email: email.slice(0, 15) },
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao cadastrar administrador.',
            errorCode: 'ADMIN_CREATION_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

router.put('/administrators/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email } = req.body;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    try {
        client = await req.db.connect();

        const result = await client.query(
            `UPDATE users 
             SET 
                name = $1, 
                email = $2, 
                updated_at = NOW() 
             WHERE id = $3 
             AND role = 'admin'
             AND company_id = $4
             RETURNING *`,
            [name, email, id, companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                message: 'Administrador não encontrado.',
                errorCode: 'ADMIN_NOT_FOUND'
            });
        }

        res.json({ 
            message: 'Administrador atualizado com sucesso.',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Erro ao atualizar administrador:', {
            error: error.message,
            adminId: id,
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao atualizar administrador.',
            errorCode: 'ADMIN_UPDATE_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

router.delete('/administrators/:id', async (req, res) => {
    const { id } = req.params;
    const companyId = req.headers['company-id'];
    let client;

    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    try {
        client = await req.db.connect();

        const result = await client.query(
            `DELETE FROM users 
             WHERE id = $1 
             AND role = 'admin'
             AND company_id = $2
             RETURNING id`,
            [id, companyId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                message: 'Administrador não encontrado.',
                errorCode: 'ADMIN_NOT_FOUND'
            });
        }

        res.json({ 
            message: 'Administrador excluído com sucesso.',
            deletedId: result.rows[0].id
        });
    } catch (error) {
        console.error('Erro ao excluir administrador:', {
            error: error.message,
            adminId: id,
            companyId: companyId.slice(0, 8)
        });
        res.status(500).json({ 
            message: 'Erro ao excluir administrador.',
            errorCode: 'ADMIN_DELETION_ERROR'
        });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;