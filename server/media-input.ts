// Indexed originals are single local media files, not playlists or scripts.
// A protocol restriction alone still lets HLS/concat follow other local files.
export const MEDIA_INPUT_VERSION = 2
export const VIDEO_CONTAINER_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,ogg,flv,asf'
export const LOCAL_VIDEO_FORMATS = VIDEO_CONTAINER_FORMATS + ',asf_o,h264,hevc,m4v,mpegvideo,mpegtsraw,ivf,obu'
const IMAGE_FORMATS = 'png_pipe,jpeg_pipe,jpegls_pipe,jpegxl_pipe,jpegxs_pipe,j2k_pipe,webp_pipe,gif,gif_pipe,apng,bmp_pipe,tiff_pipe,svg_pipe,ico,dds_pipe,exr_pipe,hdr_pipe,pfm_pipe,ppm_pipe,pgm_pipe,pbm_pipe,pam_pipe,pgmyuv_pipe,pcx_pipe,psd_pipe,sgi_pipe,sunrast_pipe,xpm_pipe,xwd_pipe,qoi_pipe'

export function localMediaInputOptions({ images = false } = {}) {
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', images ? `${IMAGE_FORMATS},${LOCAL_VIDEO_FORMATS}` : LOCAL_VIDEO_FORMATS]
}
