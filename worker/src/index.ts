export interface Env { DB: D1Database; PRODUCT_MEDIA: R2Bucket; ADMIN_TOKEN?: string; PUBLIC_MEDIA_BASE?: string; }
const json=(data:unknown,status=200)=>Response.json(data,{status});
const cors=(response:Response)=>{const h=new Headers(response.headers);h.set('Access-Control-Allow-Origin','*');h.set('Access-Control-Allow-Headers','Content-Type,Authorization');h.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');return new Response(response.body,{status:response.status,headers:h});};
export default { async fetch(request: Request, env: Env): Promise<Response> {
 const url=new URL(request.url);
 if(request.method==='OPTIONS')return cors(new Response(null,{status:204}));
 if(url.pathname==='/api/health')return cors(json({ok:true,service:'cod-sportswear-api'}));
 if(url.pathname==='/api/products'&&request.method==='GET'){
  const {results}=await env.DB.prepare("SELECT id,slug,name,description,price,status FROM products WHERE status='active' ORDER BY created_at DESC").all();
  const products=await Promise.all(results.map(async (p:any)=>{const {results:images}=await env.DB.prepare('SELECT a.id,v.width,v.r2_key,v.byte_size FROM image_assets a JOIN image_variants v ON v.image_asset_id=a.id WHERE a.product_id=? ORDER BY a.id,v.width').bind(p.id).all();return {...p,images:images.map((i:any)=>({...i,url:env.PUBLIC_MEDIA_BASE?env.PUBLIC_MEDIA_BASE+'/'+i.r2_key:null}))};}));
  return cors(json(products));
 }
 if(url.pathname==='/api/admin/images'&&request.method==='POST'){
  if(!env.ADMIN_TOKEN)return cors(json({error:'Upload service is not configured.'},503));
  if(request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return cors(json({error:'Unauthorized'},401));
  const form=await request.formData();const productId=Number(form.get('productId'));const altText=String(form.get('altText')||'');
  if(!Number.isInteger(productId)||productId<1)return cors(json({error:'Invalid product ID'},400));
  const product=await env.DB.prepare('SELECT id FROM products WHERE id=?').bind(productId).first();if(!product)return cors(json({error:'Product not found'},404));
  const files=[400,800,1200].map(width=>({width,file:form.get(String(width))})).filter(x=>x.file instanceof File);
  if(files.length<1)return cors(json({error:'Provide at least one WebP variant (400, 800 or 1200).'},400));
  for(const {file} of files){const f=file as File;if(f.type!=='image/webp'||f.size>5*1024*1024)return cors(json({error:'Variants must be WebP and under 5 MB each.'},400));}
  const asset=await env.DB.prepare('INSERT INTO image_assets(product_id,alt_text) VALUES(?,?)').bind(productId,altText).run();const imageId=asset.meta.last_row_id;
  const stored:string[]=[];
  try{for(const {width,file} of files){const f=file as File;const key=`products/${productId}/images/${imageId}/${width}.webp`;await env.PRODUCT_MEDIA.put(key,f.stream(),{httpMetadata:{contentType:'image/webp',cacheControl:'public, max-age=31536000, immutable'}});stored.push(key);await env.DB.prepare('INSERT INTO image_variants(image_asset_id,width,r2_key,content_type,byte_size) VALUES(?,?,?,?,?)').bind(imageId,width,key,'image/webp',f.size).run();}}
  catch(error){await env.DB.prepare('DELETE FROM image_assets WHERE id=?').bind(imageId).run();await Promise.all(stored.map(k=>env.PRODUCT_MEDIA.delete(k)));return cors(json({error:'Storage operation failed.'},500));}
  return cors(json({id:imageId,productId,variants:files.map(({width,file})=>({width,key:`products/${productId}/images/${imageId}/${width}.webp`,bytes:(file as File).size}))},201));
 }
 return cors(new Response('Not found',{status:404}));
}};