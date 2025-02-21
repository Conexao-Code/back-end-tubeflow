require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const { port, allowedOrigins } = require('./config');
const { connect } = require('./config/database');

// Middleware de logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  console.log('Origin:', req.headers.origin);
  next();
});

async function main() {
  const pool = await connect();

  // Configuração detalhada de CORS com logs
  const corsOptions = {
    origin: function (origin, callback) {
      console.log('Origin recebida:', origin);
      
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.error('Origem bloqueada:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
  };

  // Middleware CORS
  app.use(cors(corsOptions));
  
  // Log para verificar as opções do CORS
  console.log('Configuração CORS:');
  console.log('Origins permitidos:', allowedOrigins);
  console.log('Métodos permitidos:', corsOptions.methods);
  console.log('Headers permitidos:', corsOptions.allowedHeaders);

  app.use(express.json());

  // Middleware para verificar headers
  app.use((req, res, next) => {
    console.log('Headers na requisição:');
    console.log('Origin:', req.headers.origin);
    console.log('Access-Control-Request-Method:', req.headers['access-control-request-method']);
    console.log('Access-Control-Request-Headers:', req.headers['access-control-request-headers']);
    next();
  });

  app.use('/api', (req, res, next) => {
    req.db = pool;
    next();
  });

  // Adicionar tratamento explícito para OPTIONS
  app.options('*', cors(corsOptions), (req, res) => {
    console.log('Pré-voo OPTIONS recebido');
    res.sendStatus(200);
  });

  // Rotas
  const routes = [
    'Login', 'Cadastro', 'RegisterFreelancer', 'Dashboard', 
    'Canais', 'Videos', 'Reports', 'Logs', 'Settings', 'Admin', 'Payment'
  ];

  routes.forEach(route => {
    app.use('/api', require(`./routes/${route.toLowerCase()}`));
    console.log(`Rota /api/${route} configurada`);
  });

  // Middleware de erro para CORS
  app.use((err, req, res, next) => {
    console.error('Erro CORS:', err);
    res.status(500).json({
      error: 'Erro de CORS',
      message: err.message
    });
  });

  app.listen(port, () => {
    console.log(`\n--- Configuração do Servidor ---`);
    console.log(`Servidor rodando na porta: ${port}`);
    console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Origins permitidos: ${allowedOrigins.join(', ')}`);
    console.log(`Banco de dados: ${pool.options.connectionString}`);
    console.log('--------------------------------');
  });
}

main().catch(err => {
  console.error('Erro na inicialização:', err);
  process.exit(1);
});