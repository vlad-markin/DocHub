import datasets from '../helpers/datasets.mjs';
import storeManager from '../storage/manager.mjs';
import cache from '../storage/cache.mjs';
import queries from '../../global/jsonata/queries.mjs';
import helpers from './helpers.mjs';
import compression from '../../global/compress/compress.mjs';
import {getRoles} from '../helpers/jwt.mjs';
import {DEFAULT_ROLE, getCurrentRuleId, getCurrentRules, isRolesMode} from '../utils/rules.mjs';

const compressor = compression();

// const LOG_TAG = 'controller-core';
export default (app) => {

    // Создает ответ на JSONata запрос и при необходимости кэширует ответ
    function makeJSONataQueryResponse(res, query, params, subject, ruleId) {
        let key;
        if(isRolesMode()) {
            key = { query, params, subject, ruleId };
        } else {
            key = { query, params, subject};
        }
        cache.pullFromCache(app.storage.hash, JSON.stringify(key), async() => {
            let context;
            if(isRolesMode()) {
                context = ruleId === '' ? app.storage.manifests[DEFAULT_ROLE] : app.storage.manifests[ruleId];
            } else {
                context =  app.storage.manifest;
            }
            return await datasets(app).parseSource(
                context,
                query,
                subject,
                params
            );
        }, res);
    }

    function checkRulesManifest(ruleName) {
        for(let key in app.storage.manifests) {
            if(key === ruleName) {
                return true;
            }
        }
        return false;
    }

    // Парсит переданные во внутреннем формате данные 
    function parseRequest(req) {
        return {
            query: req.params.query,
            params: req.query?.params ? JSON.parse(req.query?.params) : undefined,
            subject: req.query?.subject ? JSON.parse(req.query?.subject) : undefined,
            baseURI: req.query?.baseuri
        };
    }

    // Выполняет произвольные запросы 
    app.get('/core/storage/jsonata/:query', async function(req, res) {
        if (!helpers.isServiceReady(app, res)) return;

        let id;
        if(isRolesMode()) {
            const roles = getRoles(req.headers);
            id = await getCurrentRuleId(roles);
            const currentRules = await getCurrentRules(roles);
            app.storage = {...app.storage, roles: [...currentRules], roleId: id};
        }
        const request = parseRequest(req);
        const query = (request.query.length === 36) && queries.QUERIES[request.query]
            ? `(${queries.makeQuery(queries.QUERIES[request.query], request.params)})`
            : request.query;

        makeJSONataQueryResponse(res, query, request.params, request.subject, id);
    });

    // Запрос на обновление манифеста
    app.put('/core/storage/reload', function(req, res) {
        const reloadSecret = req.query.secret;
        if (reloadSecret !== process.env.VUE_APP_DOCHUB_RELOAD_SECRET) {
            res.status(403).json({
                error: `Error reload secret is not valid [${reloadSecret}]`
            });
            return;
        } else {
            if(isRolesMode()) {
                app.storage = {...app.storage, manifests: null};
            }
            const oldHash = app.storage.hash;
            storeManager.reloadManifest(app)
                .then((storage) => storeManager.applyManifest(app, storage))
                .then(() => cache.clearCache(oldHash))
                .then(() => res.json({ message: 'success' }));
        }
    });

    // Выполняет произвольные запросы 
    app.get('/core/storage/release-data-profile/:query', async function(req, res) {
        if (!helpers.isServiceReady(app, res)) return;

        const request = parseRequest(req);

        let storageManifest = app.storage.manifest;
        let key = {
            path: request.query,
            params: request.params
        };

        if(isRolesMode()) {
            const roles = getRoles(req.headers);
            const id = await getCurrentRuleId(roles);
            const currentRules = await getCurrentRules(roles);
            app.storage = {...app.storage, roles: [...currentRules], roleId: id};
            storageManifest = app.storage.manifests[id];
            key ={
                path: request.query,
                params: request.params,
                roles: id
            };
        }

        cache.pullFromCache(app.storage.hash, JSON.stringify(key), async() => {
                if (request.query.startsWith('/'))
                    return await datasets(app).releaseData(request.query, request.params);
                else {
                    let profile = null;
                    const params = request.params;
                    if (request.query.startsWith('{'))
                        profile = JSON.parse(request.query);
                    else
                        profile = JSON.parse(await compressor.decodeBase64(request.query));

                    const ds = datasets(app);
                    if (profile.$base) {
                        const path = ds.pathResolver(profile.$base);
                        if (!path) {
                            res.status(400).json({
                                error: `Error $base location [${profile.$base}]`
                            });
                            return;
                        }
                        return await ds.getData(path.context, profile, params, path.baseURI);
                    } 
                    if (profile.separateDatasets && typeof profile.origin === 'object') {
                        const origin = await Promise.all(Object.keys(profile.origin).map(async(id) => {
                            return { [id]: await ds.releaseData(`/datasets/${id}`) };
                        }));
                        return await ds.getData(origin, { source: profile.source}, params);
                    }
                    return await ds.getData(storageManifest, profile, params);
                }
            }, res);
    });

    // Возвращает результат работы валидаторов
    app.get('/core/storage/problems/', async function(req, res) {
        if (!helpers.isServiceReady(app, res)) return;

        if(isRolesMode()) {
            const roles = getRoles(req.headers);
            const currentRules = await getCurrentRules(roles);
            const id = await getCurrentRuleId(roles);
            app.storage = {...app.storage, roles: [...currentRules], roleId: id};

            if (!checkRulesManifest(id)) {
                app.new_rules = currentRules;
                await storeManager.createNewManifest(app);
            }
        }
        res.json(app.storage.problems || []);
    });
};

