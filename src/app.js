require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const csurf = require('csurf');
const hpp = require('hpp');
const xss = require('xss-clean');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');
const { connect } = require('./config/database');
const logger = require('./utilities/logger');

// Importação de rotas
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

// Configuração inicial
const app = express();
const port = process.env.PORT || 3000;
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];

// Configuração de rate limiting
const apiRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // Limite de 100 requisições por IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        message: 'Muitas requisições deste IP. Tente novamente mais tarde.'
    }
});

// Middlewares de segurança
async function initializeSecurityMiddlewares() {
    // Configuração do Helmet com políticas de segurança
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: [
                    "'self'", 
                    "'unsafe-inline'", 
                    "https://apis.google.com", 
                    "https://www.googletagmanager.com"
                ],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                imgSrc: ["'self'", "data:", "https://*.mercadopago.com", "https://www.google-analytics.com"],
                connectSrc: [
                    "'self'", 
                    "https://api.mercadopago.com", 
                    "https://www.google-analytics.com"
                ],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                frameSrc: ["'self'", "https://www.google.com"],
                objectSrc: ["'none'"]
            }
        },
        crossOriginEmbedderPolicy: { policy: "require-corp" },
        crossOriginOpenerPolicy: { policy: "same-origin" },
        crossOriginResourcePolicy: { policy: "same-site" },
        dnsPrefetchControl: { allow: false },
        frameguard: { action: "deny" },
        hidePoweredBy: true,
        hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
        ieNoOpen: true,
        noSniff: true,
        permittedCrossDomainPolicies: { permittedPolicies: "none" },
        referrerPolicy: { policy: "strict-origin-when-cross-origin" },
        xssFilter: true
    }));

    // Configuração CORS
    app.use(cors({
        origin: (origin, callback) => {
            if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
                callback(null, true);
            } else {
                callback(new Error('Origem não permitida pelo CORS'));
            }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
        credentials: true,
        maxAge: 86400,
        preflightContinue: false,
        optionsSuccessStatus: 204
    }));

    // Parsers de corpo da requisição
    app.use(express.json({
        limit: '10kb',
        verify: (req, res, buf) => {
            req.rawBody = buf.toString();
        }
    }));
    
    app.use(express.urlencoded({
        extended: true,
        limit: '10kb',
        parameterLimit: 10
    }));

    // Sanitização contra XSS e injeções
    app.use(xss());
    app.use(hpp());
    app.use(mongoSanitize({
        replaceWith: '_',
        onSanitize: ({ req, key }) => {
            logger.warn(`Sanitizado parâmetro potencialmente perigoso: ${key}`, {
                ip: req.ip,
                url: req.originalUrl
            });
        }
    }));

    // Proteção CSRF
    app.use(cookieParser(process.env.COOKIE_SECRET));
    app.use(csurf({
        cookie: {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
            signed: true
        },
        value: (req) => req.headers['x-csrf-token']
    }));

    // Rate Limiting global
    app.use(apiRateLimiter);
}

// Conexão com banco de dados e inicialização
async function initializeApplication() {
    try {
        const databasePool = await connect();

        // Middleware de conexão com banco de dados
        app.use((request, response, next) => {
            request.database = databasePool;
            next();
        });

        // Rotas principais
        app.use('/api/auth', Login);
        app.use('/api/users', Cadastro);
        app.use('/api/freelancers', RegisterFreelancer);
        app.use('/api/dashboard', Dashboard);
        app.use('/api/channels', Canais);
        app.use('/api/videos', Videos);
        app.use('/api/reports', Reports);
        app.use('/api/logs', Logs);
        app.use('/api/settings', Settings);
        app.use('/api/admin', Admin);
        app.use('/api/payments', Payment);

        // Health Check endpoint
        app.get('/health', (request, response) => {
            response.status(200).json({
                status: 'operacional',
                timestamp: new Date().toISOString(),
                environment: process.env.NODE_ENV,
                security: {
                    csp: "habilitado",
                    cors: "restrito",
                    csrf: "ativo"
                }
            });
        });

        // Manipulador para rotas não encontradas
        app.use((request, response) => {
            response.status(404).json({
                status: 'erro',
                message: 'Endpoint não encontrado',
                suggestedActions: [
                    'Verifique a documentação da API',
                    'Confira o caminho da URL',
                    'Valide os métodos HTTP permitidos'
                ]
            });
        });

        // Manipulador global de erros
        app.use((error, request, response, next) => {
            const errorStatus = error.status || 500;
            const errorMessage = error.message || 'Erro interno do servidor';

            logger.error(`${errorStatus} - ${errorMessage}`, {
                path: request.path,
                method: request.method,
                ip: request.ip,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });

            response.status(errorStatus).json({
                status: 'erro',
                message: errorMessage,
                ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
            });
        });

        // Iniciar servidor
        app.listen(port, () => {
            logger.info(`Servidor seguro iniciado na porta ${port}`, {
                environment: process.env.NODE_ENV,
                securityFeatures: {
                    csp: "habilitado",
                    rateLimiting: "ativo",
                    csrfProtection: "implementado"
                }
            });
        });

    } catch (databaseError) {
        logger.error('Falha crítica na inicialização:', {
            error: databaseError.message,
            stack: databaseError.stack
        });
        process.exit(1);
    }
}

// Fluxo de inicialização
(async () => {
    try {
        await initializeSecurityMiddlewares();
        await initializeApplication();
    } catch (initializationError) {
        logger.error('Falha na inicialização do aplicativo:', {
            error: initializationError.message,
            stack: initializationError.stack
        });
        process.exit(1);
    }
})();