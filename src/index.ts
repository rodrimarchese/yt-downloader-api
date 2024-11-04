import express from 'express';
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const app = express();
app.use(express.json());

// Crear el directorio de salida si no existe
const outputDir = path.join(__dirname, 'videos');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

// Función para descargar un archivo
async function descargarArchivo(
  url: string,
  format: ytdl.videoFormat,
  outputPath: string,
  tipo: string, // 'video' o 'audio'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    ytdl(url, { format })
      .pipe(fs.createWriteStream(outputPath))
      .on('finish', () => {
        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2); // En segundos

        // Obtener el tamaño del archivo
        const stats = fs.statSync(outputPath);
        const fileSizeInBytes = stats.size;
        const fileSizeInMB = (fileSizeInBytes / (1024 * 1024)).toFixed(2);

        console.log(`Descarga de ${tipo} completada: ${outputPath}`);
        console.log(`Duración de descarga: ${duration} segundos`);
        console.log(`Tamaño del archivo: ${fileSizeInMB} MB`);

        resolve();
      })
      .on('error', (error) => {
        console.error(`Error al descargar ${outputPath}: ${error}`);
        reject(error);
      });
  });
}

app.post('/formats', async (req, res) => {
  const { url } = req.body;

  if (!url || !ytdl.validateURL(url)) {
    res.status(400).send('URL inválida.');
    return;
  }

  try {
    // Obtener información del video
    const info = await ytdl.getInfo(url);

    // Filtrar y mapear formatos de video
    const videoFormats = info.formats
      .filter((format) => format.hasVideo && !format.hasAudio)
      .map((format) => ({
        itag: format.itag,
        container: format.container || 'unknown',
        qualityLabel: format.qualityLabel || 'unknown',
        codecs: format.codecs || 'unknown',
        mimeType: format.mimeType || 'unknown',
        bitrate: format.bitrate || 0,
        fps: format.fps || 0,
        videoCodec: format.videoCodec || 'unknown',
        resolution: `${format.width || 'unknown'}x${format.height || 'unknown'}`,
      }))
      .sort((a, b) => {
        // Ordenar por resolución (altura) y luego por bitrate
        const resolutionA = parseInt(a.qualityLabel) || 0;
        const resolutionB = parseInt(b.qualityLabel) || 0;
        if (resolutionB !== resolutionA) {
          return resolutionB - resolutionA;
        } else {
          return b.bitrate - a.bitrate;
        }
      });

    // Filtrar y mapear formatos de audio
    const audioFormats = info.formats
      .filter((format) => !format.hasVideo && format.hasAudio)
      .map((format) => ({
        itag: format.itag,
        container: format.container || 'unknown',
        codecs: format.codecs || 'unknown',
        mimeType: format.mimeType || 'unknown',
        audioBitrate: format.audioBitrate || 0,
        audioCodec: format.audioCodec || 'unknown',
      }))
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));

    // Formar la respuesta
    res.status(200).json({
      videoFormats,
      audioFormats,
    });
  } catch (error) {
    console.error(`Error al obtener los formatos: ${error}`);
    res.status(500).send(`Error al obtener los formatos: ${error}`);
  }
});

app.post('/download', async (req, res) => {
  const { url, videoItag, audioItag } = req.body;

  if (!url || !ytdl.validateURL(url)) {
    res.status(400).send('URL inválida.');
    return;
  }

  const videoId = ytdl.getURLVideoID(url);
  const outputPath = path.join(outputDir, `${videoId}.mp4`);

  try {
    // Obtener información del video
    const info = await ytdl.getInfo(url);

    let videoFormat: ytdl.videoFormat | null = null;
    let audioFormat: ytdl.videoFormat | null = null;

    // Obtener los formatos disponibles y ordenarlos
    const videoFormats = info.formats
      .filter((format) => format.hasVideo && !format.hasAudio)
      .sort((a, b) => {
        const resolutionA = parseInt(a.qualityLabel) || 0;
        const resolutionB = parseInt(b.qualityLabel) || 0;
        if (resolutionB !== resolutionA) {
          return resolutionB - resolutionA;
        } else {
          return (b.bitrate || 0) - (a.bitrate || 0);
        }
      });

    const audioFormats = info.formats
      .filter((format) => !format.hasVideo && format.hasAudio)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));

    // Seleccionar los formatos de video y audio
    if (videoItag) {
      videoFormat = ytdl.chooseFormat(info.formats, { quality: videoItag });
    } else {
      // Seleccionar el mejor formato de video
      videoFormat = videoFormats[0];
    }

    if (audioItag) {
      audioFormat = ytdl.chooseFormat(info.formats, { quality: audioItag });
    } else {
      // Seleccionar el mejor formato de audio
      audioFormat = audioFormats[0];
    }

    if (!videoFormat || !audioFormat) {
      res
        .status(500)
        .send('No se pudieron encontrar formatos adecuados de video y audio.');
      return;
    }

    // Rutas para los archivos temporales
    const videoPath = path.join(
      outputDir,
      `${videoId}_video.${videoFormat.container || 'mp4'}`,
    );
    const audioPath = path.join(
      outputDir,
      `${videoId}_audio.${audioFormat.container || 'mp4'}`,
    );

    // Descargar video y audio
    await Promise.all([
      descargarArchivo(url, videoFormat, videoPath, 'video'),
      descargarArchivo(url, audioFormat, audioPath, 'audio'),
    ]);

    // Combinar video y audio usando fluent-ffmpeg
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions('-c', 'copy')
      .save(outputPath)
      .on('end', () => {
        console.log('Video y audio combinados exitosamente.');

        // Eliminar archivos temporales
        fs.unlinkSync(videoPath);
        fs.unlinkSync(audioPath);

        res.status(200).send('Video descargado y procesado exitosamente.');
      })
      .on('error', (error: any) => {
        console.error(`Error al combinar video y audio: ${error}`);
        res.status(500).send(`Error al combinar video y audio: ${error}`);
      });
  } catch (error) {
    console.error(`Error al procesar el video: ${error}`);
    res.status(500).send(`Error al procesar el video: ${error}`);
  }
});

app.listen(3003, () => {
  console.log('Servidor escuchando en el puerto 3003');
});
