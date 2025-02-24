// config.js
require('dotenv').config();

module.exports = {
    dbConfig: {
        dbType: process.env.DB_TYPE || 'postgres',
        mysql: {
            host: process.env.MYSQL_HOST || "77.37.43.248",
            port: process.env.MYSQL_PORT || 3306,
            user: process.env.MYSQL_USER || "tubeflow",
            password: process.env.MYSQL_PASSWORD || "7CjSa>0;g",
            database: process.env.MYSQL_DB || "tubeflow",
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            ssl: process.env.MYSQL_SSL ? { rejectUnauthorized: false } : null
        },
        postgres: {
            connectionString: process.env.DATABASE_URL || 'postgresql://tubeflow:tubeflow@145.223.29.205:5432/tubeflow',
            ssl: process.env.DB_SSL === 'true' ? {
                rejectUnauthorized: false,
                ca: process.env.PG_SSL_CA
            } : false,
            max: parseInt(process.env.PG_POOL_SIZE) || 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000
        }
    },
    orderQuantityDefault: 2,
    fetchInterval: 30 * 60 * 1000,
    queueProcessInterval: 5000,
    port: process.env.PORT || 1100,

    baseUrl: 'https://apitubeflow.conexaocode.com',
    
    allowedOrigins: [
        'http://localhost:5173',
        'http://localhost:3001',
        'http://77.37.43.248:3333',
        process.env.CORS_ORIGIN
    ].filter(Boolean),
    
    postgresSettings: {
        schema: process.env.PG_SCHEMA || 'public',
        statementTimeout: 5000,
        query_timeout: 10000
    }
};