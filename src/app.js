require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const { port } = require('./config');
const { pool } = require('./config/database');
const Login = require('./routes/login');
const Cadastro = require('./routes/cadastro');
const RegisterFreelancer = require('./routes/registerfreelancer');
const Dashboard = require('./routes/dashboard');
const Canais = require('./routes/canais');
const Videos = require('./routes/videos');
const Reports = require('./routes/reports');
const Logs = require('./routes/logs');
const Settings = require('./routes/settings');
const Admin = require('./routes/admin');
const Payment = require('./routes/payment');

async function main() {
    // Configurações básicas do Express
    app.use(cors({
        origin: '*',
        optionsSuccessStatus: 200
    }));

    app.use(express.json());

    // Middleware para injetar o pool do PostgreSQL
    app.use('/api', (req, res, next) => {
        req.db = pool;
        next();
    });

    // Rotas
    app.use('/api', Login);
    app.use('/api', Cadastro);
    app.use('/api', RegisterFreelancer);
    app.use('/api', Dashboard);
    app.use('/api', Canais);
    app.use('/api', Videos);
    app.use('/api', Settings);
    app.use('/api', Logs);
    app.use('/api', Admin);
    app.use('/api', Reports);
    app.use('/api', Payment);

    // Teste de conexão com o banco
    try {
        await pool.query('SELECT NOW()');
        console.log('Conexão com PostgreSQL estabelecida com sucesso!');
    } catch (error) {
        console.error('Erro na conexão com PostgreSQL:', error);
    }

    // Inicia o servidor
    app.listen(port, () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
}

main().catch(error => {
    console.error('Erro crítico na inicialização:', error);
    process.exit(1);
});