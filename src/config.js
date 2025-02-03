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
        'http://77.37.43.248:3333'
    ],
};

//2872cbb3-a25f-4149-bc83-fd6635d8187b
//e61c229a-91e5-466c-bb90-e0d5b4833a23