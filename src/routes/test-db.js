// test-db.js
require('dotenv').config();
const { Pool } = require('pg');
const config = require('../config');

async function testConnection() {
    try {
        console.log('🔄 Iniciando teste de conexão com PostgreSQL...');
        
        const dbConfig = config.dbConfig.postgres;
        
        console.log('⚙️ Configurações utilizadas:', {
            host: new URL(dbConfig.connectionString).hostname,
            port: new URL(dbConfig.connectionString).port,
            database: new URL(dbConfig.connectionString).pathname.replace('/', ''),
            user: new URL(dbConfig.connectionString).username,
            ssl: dbConfig.ssl
        });

        const pool = new Pool(dbConfig);
        
        // Teste básico de conexão
        const client = await pool.connect();
        console.log('✅ Conexão estabelecida com sucesso!');
        
        // Teste de query
        const result = await client.query('SELECT NOW() as current_time');
        console.log('⏱ Hora do servidor:', result.rows[0].current_time);
        
        // Verificação de SSL
        const sslResult = await client.query('SELECT ssl_is_used()');
        console.log('🔒 SSL ativo:', sslResult.rows[0].ssl_is_used);
        
        // Versão do PostgreSQL
        const version = await client.query('SELECT version()');
        console.log('🛠 Versão do PostgreSQL:', version.rows[0].version.split(' ')[1]);

        client.release();
        await pool.end();
        
        console.log('🎉 Teste concluído com sucesso!');
        
    } catch (error) {
        console.error('❌ Falha na conexão:', error);
        process.exit(1);
    }
}

testConnection();