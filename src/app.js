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

    // Configuração de CORS com origens permitidas
    app.use(cors({
        origin: function (origin, callback) {
            // Adiciona a origem do front-end à lista de permitidas
            const allAllowedOrigins = [...allowedOrigins, 'https://tubeflow.conexaocode.com'];
            
            // Permite requisições sem origem (como Postman) ou origens permitidas
            if (!origin || allAllowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Origem não permitida pelo CORS'));
            }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Métodos permitidos
        allowedHeaders: ['Content-Type', 'Authorization'],     // Cabeçalhos permitidos
        optionsSuccessStatus: 200                             // Resposta para requisições OPTIONS
    }));

    app.use(express.json());

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

    app.listen(port, async () => {
        console.log(`Servidor rodando na porta ${port}`);
    });
}

main().catch(console.error);