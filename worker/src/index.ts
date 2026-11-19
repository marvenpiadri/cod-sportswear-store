export interface Env { DB: D1Database; PRODUCT_MEDIA: R2Bucket; ADMIN_PIN?: string; PUBLIC_MEDIA_BASE?: string; }
const json=(data:unknown,status=200)=>Response.json(data,{status});
const cors=(response:Response)=>{const h=new Headers(response.headers);h.set('Access-Control-Allow-Origin','*');h.set('Access-Control-Allow-Headers','Content-Type,Authorization');h.set('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');return new Response(response.body,{status:response.status,headers:h});};
const authorized=(request:Request,env:Env)=>!!env.ADMIN_PIN&&request.headers.get('Authorization')===`Bearer ${env.ADMIN_PIN}`;
const ADMIN_LIMIT=10, ADMIN_WINDOW_MS=15*60*1000;
async function adminAuth(request:Request,env:Env){
 const ip=request.headers.get('CF-Connecting-IP')||'unknown'; const cutoff=new Date(Date.now()-ADMIN_WINDOW_MS).toISOString();
 const recent=await env.DB.prepare('SELECT COUNT(*) AS attempts FROM admin_pin_attempts WHERE ip=? AND attempted_at>?').bind(ip,cutoff).first<any>();
 if(Number(recent?.attempts||0)>=ADMIN_LIMIT)return {ok:false,response:json({error:'Too many PIN attempts. Try again in 15 minutes.'},429)};
 if(authorized(request,env)){await env.DB.prepare('DELETE FROM admin_pin_attempts WHERE attempted_at<?').bind(cutoff).run();return {ok:true};}
 await env.DB.prepare('INSERT INTO admin_pin_attempts(ip,attempted_at) VALUES(?,?)').bind(ip,new Date().toISOString()).run(); return {ok:false,response:json({error:'Unauthorized'},401)};
}
const mediaUrl=(env:Env,key:string)=>env.PUBLIC_MEDIA_BASE?`${env.PUBLIC_MEDIA_BASE.replace(/\/$/,'')}/${key}`:null;
async function catalog(env:Env,activeOnly:boolean){
 const sql=activeOnly?"SELECT id,slug,name,description,price,status FROM products WHERE status='active' ORDER BY created_at DESC":"SELECT id,slug,name,description,price,status FROM products ORDER BY created_at DESC";
 const {results}=await env.DB.prepare(sql).all();
 return Promise.all(results.map(async(p:any)=>{const {results:images}=await env.DB.prepare('SELECT a.id,a.alt_text,v.width,v.r2_key,v.byte_size FROM image_assets a JOIN image_variants v ON v.image_asset_id=a.id WHERE a.product_id=? ORDER BY a.id,v.width').bind(p.id).all();return {...p,images:images.map((i:any)=>({...i,url:mediaUrl(env,i.r2_key)}))};}));
}
export default { async fetch(request: Request, env: Env): Promise<Response> {
 const url=new URL(request.url);
 if(request.method==='OPTIONS')return cors(new Response(null,{status:204}));
 if(url.pathname==='/api/health')return cors(json({ok:true,service:'cod-sportswear-api'}));
 if(url.pathname==='/api/products'&&request.method==='GET')return cors(json(await catalog(env,true)));
 if(url.pathname==='/api/orders'&&request.method==='POST'){
  let body:any;try{body=await request.json();}catch{return cors(json({error:'Invalid JSON'},400));}
  const customer=body.customer||{},items=Array.isArray(body.items)?body.items:[];
  const name=String(customer.fullName||'').trim(),phone=String(customer.phone||'').trim(),whatsapp=String(customer.whatsapp||phone).trim(),city=String(customer.city||'').trim(),address=String(customer.address||'').trim(),note=String(customer.note||'').trim();
  if(!name||name.length>120||!phone||phone.length>30||!/^\+?[0-9\s().-]{5,25}$/.test(phone)||!whatsapp||whatsapp.length>30||!/^\+?[0-9\s().-]{5,25}$/.test(whatsapp)||!city||city.length>100||!address||address.length>500||note.length>500||!items.length||items.length>30)return cors(json({error:'Please check customer details and cart items. Fields may be too long or phone numbers invalid.'},400));
  const safeItems=[];for(const item of items){const id=Number(item.productId),qty=Number(item.quantity);if(!Number.isInteger(id)||id<1||!Number.isInteger(qty)||qty<1||qty>20)return cors(json({error:'Invalid cart item.'},400));const product:any=await env.DB.prepare("SELECT id,name,price FROM products WHERE id=? AND status='active'").bind(id).first();if(!product)return cors(json({error:'One of the products is no longer available.'},409));safeItems.push({...product,quantity:qty,lineTotal:product.price*qty});}
  const subtotal=safeItems.reduce((sum,item)=>sum+item.lineTotal,0);if(subtotal>10000000)return cors(json({error:'Order total is too high.'},400));
  const customerResult=await env.DB.prepare('INSERT INTO customers(full_name,phone,whatsapp_phone,city,address,delivery_note) VALUES(?,?,?,?,?,?)').bind(name,phone,whatsapp,city,address,note).run();const customerId=customerResult.meta.last_row_id;
  const orderNumber='COD-'+Date.now().toString(36).toUpperCase();const orderResult=await env.DB.prepare("INSERT INTO orders(order_number,customer_id,status,payment_method,payment_status,currency,subtotal,delivery_fee,total) VALUES(?,?,'pending','cod','unpaid','MAD',?,0,?)").bind(orderNumber,customerId,subtotal,subtotal).run();const orderId=orderResult.meta.last_row_id;
  await env.DB.batch(safeItems.map(item=>env.DB.prepare('INSERT INTO order_items(order_id,variant_id,product_name,sku,size,color,unit_price,quantity,line_total) VALUES(?,NULL,?,? ,\'\',\'\',?,?,?)').bind(orderId,item.name,'PRODUCT-'+item.id,item.price,item.quantity,item.lineTotal)));
  return cors(json({orderId,orderNumber,total:subtotal,currency:'MAD',status:'pending'},201));
 }

 if(url.pathname==='/api/admin/orders'&&request.method==='GET'){const auth=await adminAuth(request,env);if(!auth.ok)return cors(auth.response!);const {results}=await env.DB.prepare('SELECT o.id,o.order_number,o.total,o.created_at,c.full_name,c.phone,c.whatsapp_phone,c.city,c.address FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 50').all();return cors(json(results));}
 if(url.pathname==='/api/admin/products'&&request.method==='GET'){if(!authorized(request,env))return cors(json({error:'Unauthorized'},401));return cors(json(await catalog(env,false)));}
 if(url.pathname==='/api/admin/products'&&request.method==='POST'){
  if(!authorized(request,env))return cors(json({error:'Unauthorized'},401));
  let body:any;try{body=await request.json();}catch{return cors(json({error:'Invalid JSON'},400));}
  const name=String(body.name||'').trim(),description=String(body.description||'').trim(),price=Number(body.price),status=body.status==='active'?'active':'draft';
  if(!name||name.length>160||!Number.isSafeInteger(price)||price<0||price>1000000)return cors(json({error:'Name and valid price are required.'},400));
  const slug=String(body.slug||name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).slice(0,160);
  if(!slug)return cors(json({error:'Invalid slug'},400));
  try{const result=await env.DB.prepare('INSERT INTO products(slug,name,description,price,status) VALUES(?,?,?,?,?)').bind(slug,name,description,price,status).run();return cors(json({id:result.meta.last_row_id,slug,name,description,price,status},201));}catch{return cors(json({error:'Slug may already exist.'},409));}
 }
 if(url.pathname==='/api/admin/images'&&request.method==='POST'){
  if(!authorized(request,env))return cors(json({error:'Unauthorized'},401));
  const form=await request.formData();const productId=Number(form.get('productId'));const altText=String(form.get('altText')||'');
  if(!Number.isInteger(productId)||productId<1)return cors(json({error:'Invalid product ID'},400));
  const product=await env.DB.prepare('SELECT id FROM products WHERE id=?').bind(productId).first();if(!product)return cors(json({error:'Product not found'},404));
  const files=[400,800,1200].map(width=>({width,file:form.get(String(width))})).filter(x=>x.file instanceof File);
  if(files.length<1)return cors(json({error:'Provide at least one WebP variant (400, 800 or 1200).'},400));
  for(const {file} of files){const f=file as File;if(f.type!=='image/webp'||f.size>5*1024*1024)return cors(json({error:'Variants must be WebP and under 5 MB each.'},400));}
  const asset=await env.DB.prepare('INSERT INTO image_assets(product_id,alt_text) VALUES(?,?)').bind(productId,altText).run();const imageId=asset.meta.last_row_id;const stored:string[]=[];
  try{for(const {width,file} of files){const f=file as File;const key=`products/${productId}/images/${imageId}/${width}.webp`;await env.PRODUCT_MEDIA.put(key,f.stream(),{httpMetadata:{contentType:'image/webp',cacheControl:'public, max-age=31536000, immutable'}});stored.push(key);await env.DB.prepare('INSERT INTO image_variants(image_asset_id,width,r2_key,content_type,byte_size) VALUES(?,?,?,?,?)').bind(imageId,width,key,'image/webp',f.size).run();}}
  catch{await env.DB.prepare('DELETE FROM image_assets WHERE id=?').bind(imageId).run();await Promise.all(stored.map(k=>env.PRODUCT_MEDIA.delete(k)));return cors(json({error:'Storage operation failed.'},500));}
  return cors(json({id:imageId,productId,variants:files.map(({width,file})=>({width,key:`products/${productId}/images/${imageId}/${width}.webp`,bytes:(file as File).size}))},201));
 }
 return cors(new Response('Not found',{status:404}));
}};