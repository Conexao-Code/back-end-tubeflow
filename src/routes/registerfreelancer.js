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

    // Validação do Company ID
    if (!companyId) {
        return res.status(400).json({ 
            message: 'Company ID é obrigatório.',
            errorCode: 'MISSING_COMPANY_ID'
        });
    }

    // Validação de campos obrigatórios
    if (!name || !email || !role || !phone) {
        return res.status(400).json({ 
            message: 'Nome, e-mail, função e telefone são obrigatórios.',
            requiredFields: ['name', 'email', 'role', 'phone'],
            errorCode: 'MISSING_REQUIRED_FIELDS'
        });
    }

    // Normalização e validação da função
    const normalizedRole = role.toString().toLowerCase().trim();
    const allowedRoles = ['roteirista', 'editor', 'narrador', 'thumb maker'];
    
    if (!allowedRoles.includes(normalizedRole)) {
        return res.status(400).json({
            message: 'Função inválida.',
            allowedRoles: allowedRoles.map(r => r.charAt(0).toUpperCase() + r.slice(1)),
            receivedRole: role,
            errorCode: 'INVALID_ROLE'
        });
    }

    try {
        client = await req.db.connect();

        // Verificação de e-mail único por empresa
        const emailCheck = await client.query(
            'SELECT id FROM freelancers WHERE email = $1 AND company_id = $2',
            [email, companyId]
        );

        if (emailCheck.rows.length > 0) {
            return res.status(409).json({ 
                message: 'E-mail já cadastrado para esta empresa.',
                errorCode: 'DUPLICATE_EMAIL'
            });
        }

        // Geração de senha segura
        const generatedPassword = crypto.randomBytes(10).toString('hex');
        const hashedPassword = await bcrypt.hash(generatedPassword, 12);

        // Inserção no banco de dados
        const insertResult = await client.query(
            `INSERT INTO freelancers (
                name, 
                email, 
                role, 
                phone, 
                password, 
                company_id, 
                created_at, 
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            RETURNING id, created_at`,
            [name, email, normalizedRole, phone, hashedPassword, companyId]
        );

        // Envio de e-mail com template profissional
        await transporter.sendMail({
            from: '"Suporte TubeFlow" <contato@conexaocode.com>',
            to: email,
            subject: 'Cadastro Realizado - TubeFlow',
            html: `
                <div style="font-family: 'Poppins', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <img src="https://apitubeflow.conexaocode.com/logo.png" alt="Logo TubeFlow" style="height: 50px; margin-bottom: 20px;">
                        <h1 style="color: #2d3748; font-size: 24px; margin-bottom: 10px;">Bem-vindo(a) à Plataforma TubeFlow</h1>
                        <p style="color: #4a5568; font-size: 16px;">Seu cadastro foi realizado com sucesso!</p>
                    </div>

                    <div style="background-color: #f7fafc; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                        <h2 style="color: #2d3748; font-size: 18px; margin-bottom: 15px;">Detalhes de Acesso</h2>
                        <div style="margin-bottom: 10px;">
                            <span style="color: #4a5568; font-weight: 500;">E-mail:</span>
                            <span style="color: #2d3748;">${email}</span>
                        </div>
                        <div style="margin-bottom: 10px;">
                            <span style="color: #4a5568; font-weight: 500;">Senha Temporária:</span>
                            <span style="color: #2d3748; font-family: monospace;">${generatedPassword}</span>
                        </div>
                        <div style="color: #718096; font-size: 14px;">
                            <p>Recomendamos que:</p>
                            <ul style="margin-top: 5px; padding-left: 20px;">
                                <li>Altere sua senha no primeiro acesso</li>
                                <li>Mantenha suas credenciais em local seguro</li>
                                <li>Utilize autenticação de dois fatores</li>
                            </ul>
                        </div>
                    </div>

                    <div style="text-align: center; color: #718096; font-size: 14px;">
                        <p>Este é um e-mail automático, por favor não responda.</p>
                        <p style="margin-top: 10px;">Equipe TubeFlow</p>
                        <p style="margin-top: 5px;">
                            <a href="https://conexaocode.com" style="color: #4299e1; text-decoration: none;">Suporte Técnico</a> | 
                            <a href="https://conexaocode.com/privacidade" style="color: #4299e1; text-decoration: none;">Política de Privacidade</a>
                        </p>
                    </div>
                </div>
            `
        });

        // Resposta de sucesso
        res.status(201).json({
            message: 'Freelancer cadastrado com sucesso.',
            data: {
                id: insertResult.rows[0].id,
                createdAt: insertResult.rows[0].created_at
            },
            emailStatus: 'Credentials sent to ' + email
        });

    } catch (error) {
        console.error('Erro completo no registro:', {
            error: error.message,
            stack: error.stack,
            params: { name, email, role, phone: phone?.slice(0, 6) + '****' },
            companyId: companyId?.slice(0, 8)
        });

        res.status(500).json({ 
            message: 'Erro no processo de cadastro.',
            error: process.env.NODE_ENV === 'development' ? {
                code: error.code,
                detail: error.detail,
                constraint: error.constraint
            } : undefined,
            errorCode: 'REGISTRATION_FAILURE'
        });

    } finally {
        if (client) {
            try {
                await client.release();
            } catch (releaseError) {
                console.error('Erro ao liberar conexão:', releaseError);
            }
        }
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