import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { downloadActionsService, downloadQualitySchema } from '../../download-actions.js';
import { parseBody, routeErrorHandler } from './route-utils.js';

const router = Router();

/** Same cap as BatchImportService.importUrls. */
const MAX_BATCH_URLS = 1000;

const importBody = z.object({
    urls: z.array(z.string().max(2048)).min(1).max(MAX_BATCH_URLS),
    quality: downloadQualitySchema.nullish(),
    createZip: z.boolean().optional()
});

router.post('/import/direct', async (req: Request, res: Response) => {
    const { urls, quality, createZip } = parseBody(importBody, req.body);
    const q = downloadActionsService.resolveQuality(quality);
    downloadActionsService.ensureReady();

    const { batchImportService } = await import('../../batch.js');
    const result = await batchImportService.importUrls(urls, q, createZip === true);

    res.json({
        success: result.imported > 0,
        imported: result.imported,
        failed: result.failed,
        errors: result.errors.slice(0, 50),
        message: `Processed ${urls.length} URLs. ${result.imported} added to queue.`
    });
});

router.use(routeErrorHandler('batch'));

export default router;
