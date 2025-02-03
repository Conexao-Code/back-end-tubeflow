require('dotenv').config();

const mysql = require('mysql2');

const dbUrl = "mysql://tubeflow:7CjSa>0;g@tubeflow_tubeflow:3306/tubeflow";

const pool = mysql.createPool(dbUrl, {
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = {
    dbConfig: pool.promise(), // Usar `.promise()` para suporte a async/await
    orderQuantityDefault: 2,
    fetchInterval: 30 * 60 * 1000, 
    queueProcessInterval: 5000,
    port: 1100,
    
    allowedOrigins: [
        'http://localhost:5173',
        'http://localhost:3001',
        'http://77.37.43.248:3333',
        'https://cms.vroxmidias.com'
    ],
};
