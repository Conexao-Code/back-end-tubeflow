const mysql = require('mysql2/promise');
const { dbConfig } = require('../config');

function getCaller() {
    const originalFunc = Error.prepareStackTrace;
    let callerFile;
    try {
        const err = new Error();
        Error.prepareStackTrace = function (_, stack) { return stack; };
        const currentFile = err.stack.shift().getFileName();
        while (err.stack.length) {
            callerFile = err.stack.shift().getFileName();
            if (currentFile !== callerFile) break;
        }
    } catch (e) { }
    Error.prepareStackTrace = originalFunc;
    return callerFile;
}

async function connect() {

    const pool = mysql.createPool(dbConfig);

    pool.on('connection', (connection) => {
        connection.query('SET time_zone = "-03:00"');
    });

    return pool;
}

module.exports = { connect };
