require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const { port, allowedOrigins } = require('./config');
const { connect } = require('./config/database');
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
    const pool = await connect();

    app.use(cors({
        origin: '*',
        optionsSuccessStatus: 200
    }));

    app.use(express.json());

    app.use('/api', (req, res, next) => {
        req.db = pool;
        next();
    });

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

    app.listen(port, async () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
}

main().catch(console.error);