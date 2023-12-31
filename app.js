/* ******** imports ******* */
const { existsSync } = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { infoAsync, errorAsync, warnAsync, isValidAmount } = require('./apputils');
const { isLogin, login, register, lockUser, deposit, withdraw, changePass } = require('./browse');
const { createTransaction, getTransactionsAndWorkbook } = require('./db');

require('dotenv').config();

/* ******** declarations & initializations ******* */
const app = express();
const PORT = 5000;
const bodyParser = require('body-parser');
const constants = require('./constants');
const loginCache = new Map();
const allowedDomains = ['http://fgpunt.com', 'https://fgpunt.com'];
const corsOptions = {
    origin: null,
    methods: 'POST, GET',
    credentials: false,
    optionsSuccessStatus: 204
};

/* ******** browser setup ******* */
var browser;

(async () => {
    browser = await puppeteer.launch({
        args: [
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--single-process',
            '--no-zygote',
            '--disable-gpu',
        ],
        executablePath:
            process.env.NODE_ENV === 'production'
                ? process.env.PUPPETEER_EXECUTABLE_PATH
                : puppeteer.executablePath(),
        headless: true,
        timeout: 120000,
        defaultViewport: { width: 1600, height: 900 },
    });
})();

/* ******** middleware setup ******* */
app.use(express.json());
app.use(bodyParser.json());
app.use(cors(corsOptions));
app.use(express.static('public'));
app.use((req, res, next) => {
    const { url } = req.body;

    if (loginCache.has(url) && loginCache.get(url).isBusy) {
        return res.status(429).json(`the site is busy`);
    }

    if (!['/login', '/logs', '/credentials', '/details', '/generate-excel'].includes(req.path)) {
        if (!loginCache.has(url)) return res.status(404).send('admin missing, login to continue');

        loginCache.set(url, {
            ...loginCache.get(url),
            isBusy: true
        });

        isLogin(loginCache, url)
            .then(isLogin => {

                if (!isLogin) {
                    const { page, username, password } = loginCache.get(url);

                    login(page, url, username, password)
                        .then((loginSuccess) => {
                            if (loginSuccess) {
                                next();
                                loginCache.get(url).isBusy = false;
                                return;
                            }

                            res.status(400).send('admin updated login again');
                            loginCache.get(url).isBusy = false;
                            return;
                        })
                        .catch(err => {
                            res.status(400).send(err.message)
                            loginCache.get(url).isBusy = false;
                        });

                    return;
                }

                next();
                if (loginCache.has(url))
                    loginCache.get(url).isBusy = false;
            });

        return;
    }

    next();
});

/* ******** api ******* */

app.get('/', (req, res) => res.send('server up and running'))

app.get('/credentials', async (req, res) => {
    const filePath = path.join(__dirname, 'public', 'addsite.html');
    res.sendFile(filePath);
});

app.get('/details', async (req, res) => {
    const filePath = path.join(__dirname, 'public', 'downloadlogs.html');
    res.sendFile(filePath);
});


app.post('/generate-excel', (req, res) => {
    const { startDate, endDate } = req.body;

    getTransactionsAndWorkbook(startDate, endDate, req.headers.host)
        .then(workbook => {
            // Set the response headers to indicate an Excel file
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=log-${startDate}-${endDate}.xlsx`);

            // Write the Excel workbook to the response
            workbook.xlsx.write(res)
                .catch(err => {
                    res.status(500).send('Error generating Excel file');
                    errorAsync(err.message);
                });
        })
        .catch(err => {
            res.status(500).send('Error: ' + err);
            errorAsync(err);
        });
});

app.post('/login', async (req, res) => {
    const { url, username, password } = req.body;

    if (loginCache.has(url))
        loginCache.get(url).isBusy = true;

    if (await isLogin(loginCache, url)) {
        res.status(200).json({ message: 'login already awailable for url: ' + url });
        loginCache.get(url).isBusy = false;
        return;
    }

    try {
        const page = loginCache.has(url) ? loginCache.get(url).page : await browser.newPage();
        loginCache.set(url, {
            page: page,
            username: username,
            password: password,
            isBusy: true
        });

        await login(page, url, username, password);

        res.status(200).json({ message: 'login success to url ' + url });

    } catch (ex) {
        errorAsync(ex.message);
        res.status(400).json({ message: ex.message });
    } finally {
        loginCache.get(url).isBusy = false;
    }
});

app.post('/register', async (req, res) => {
    const { url, username } = req.body;
    const page = loginCache.get(url).page;

    try {
        const result = await register(page, username);
        if (result.success)
            res.status(200).json({ message: result.message, defaultPassword: constants.DEFAULT_PASSWORD });
        else
            res.status(400).json({ message: 'User registration not successful', result });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
        errorAsync(`request responded with error: ${error.message}`);
    }
});

app.post('/changepass', async (req, res) => {
    const { url, username, pass } = req.body;
    const page = loginCache.get(url).page;

    try {
        const result = await changePass(page, username, pass);
        res.status(result.success ? 200 : 400).json(result);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
        errorAsync(error.message);
    }
});

app.post('/deposit', async (req, res) => {
    const { url, username, amount } = req.body;
    const page = loginCache.get(url).page;
    let result;
    let responseTime;
    let status = false;
    try {
        if (!isValidAmount(amount)) {
            res.status(400).json({ message: "invalid amount format" });
            return;
        }

        infoAsync(`[req] ${url}, user: ${username}, amount: ${amount}`);
        const startTime = new Date();
        const result = await deposit(page, username, amount);
        const endTime = new Date();
        responseTime = endTime - startTime;
        if (result.success == false) {
            res.status(400).json({ message: 'deposit not successful', result });
            warnAsync(`[res] url: ${url}, status: ${res.statusCode}, user: ${username}, message: ${result.message} (${responseTime} ms)`);
        } else {
            res.json({ message: 'deposited successfully', result });
            status = true;
            infoAsync(`[res] url: ${url}, status: ${res.statusCode}, user: ${username}, amount: ${amount}, message: ${result.message} (${responseTime} ms)`);
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
        errorAsync(`[res] ${url} - ${res.statusCode}, Message: ${error.message}`);
    } finally {
        createTransaction(url, 'd', username, amount, responseTime, res.message, status, req.headers.host);
    }

});

app.post('/withdraw', async (req, res) => {
    const { url, username, amount } = req.body;
    const page = loginCache.get(url).page;
    let result;
    let responseTime;
    let status = false;
    try {
        if (!isValidAmount(amount)) {
            res.status(400).json({ message: "invalid amount format" });
            return;
        }

        infoAsync(`[req] ${url}, user: ${username}, amount: ${amount}`);
        const startTime = new Date();
        const result = await withdraw(page, username, amount);
        const endTime = new Date();
        const responseTime = endTime - startTime;
        if (result.success == false) {
            res.status(400).json({ message: 'withdraw not successful', result });
            warnAsync(`[res] url: ${url}, status: ${res.statusCode}, user: ${username}, message: ${result.message} (${responseTime} ms)`);
        } else {
            res.json({ message: 'Withdrawn successfully', result });
            status = true;
            infoAsync(`[res] url: ${url}, status: ${res.statusCode}, user: ${username}, amount: ${amount}, message: ${result.message} (${responseTime} ms)`);
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
        errorAsync(error.message);
    }
    finally {
        createTransaction(url, 'w', username, amount, responseTime, res.message, status, req.headers.host);
    }
});

app.post('/lockuser', async (req, res) => {
    const { url, username } = req.body;
    const page = loginCache.get(url).page;

    try {
        const result = await lockUser(page, username);
        res.json({ message: 'User locked successfully', result });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
        errorAsync(err.message);
    }

});

app.post('/logs', async (req, res) => {
    const date = req.body.date;

    if (!date) {
        return res.status(400).json({ error: 'Date is required in the request body.' });
    }

    if (!/^\d{4}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Please use yyyy-mm.' });
    }

    const filePath = path.join(__dirname, 'logs', `combined-${date}.log`);

    if (!existsSync(filePath)) {
        return res.status(404).json({ error: 'Log file not found.' });
    }

    res.sendFile(filePath, (err) => {
        if (err) {
            errorAsync(err.message);
            res.status(500).send('Error sending the file.');
        }
    });
});

/* ******** server startup & shutdown ******* */
app.listen(PORT);

process.on('SIGINT', () => {
    browser.close();
});
