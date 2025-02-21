module.exports = {
    dbConfig: {
        host: "77.37.43.248",
        user: "tubeflow",
        password: "7CjSa>0;g",
        database: "tubeflow",
        waitForConnections: true, 
        connectionLimit: 10, 
        queueLimit: 0 
    },
    orderQuantityDefault: 2,
    fetchInterval: 30 * 60 * 1000, 
    queueProcessInterval: 5000,
    port: 1100,
    allowedOrigins: [
        'http://localhost:5173',
        'http://localhost:3001',
        'http://77.37.43.248:3333',
        'https://tubeflow.conexaocode.com' // Adicionado
    ],
};