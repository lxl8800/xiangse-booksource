import json,struct
key=bytes.fromhex('e587bce8a486e6bbbfe98791e6baa1e5')
MASK=0xffffffff

def cipher(v,k,encrypt=True):
 n=len(v); delta=0x9e3779b9
 if encrypt:
  rounds=6+52//n; su=0; z=v[-1]
  for _ in range(rounds):
   su=(su+delta)&MASK;e=(su>>2)&3
   for p in range(n-1):
    y=v[p+1];mx=(((z>>5 ^ y<<2)+(y>>3 ^ z<<4)) ^ ((su ^ y)+(k[(p&3)^e]^z)))&MASK
    v[p]=(v[p]+mx)&MASK;z=v[p]
   y=v[0];p=n-1;mx=(((z>>5 ^ y<<2)+(y>>3 ^ z<<4)) ^ ((su ^ y)+(k[(p&3)^e]^z)))&MASK
   v[p]=(v[p]+mx)&MASK;z=v[p]
 else:
  rounds=6+52//n;su=(rounds*delta)&MASK;y=v[0]
  for _ in range(rounds):
   e=(su>>2)&3
   for p in range(n-1,0,-1):
    z=v[p-1];mx=(((z>>5 ^ y<<2)+(y>>3 ^ z<<4)) ^ ((su ^ y)+(k[(p&3)^e]^z)))&MASK
    v[p]=(v[p]-mx)&MASK;y=v[p]
   z=v[-1];p=0;mx=(((z>>5 ^ y<<2)+(y>>3 ^ z<<4)) ^ ((su ^ y)+(k[(p&3)^e]^z)))&MASK
   v[p]=(v[p]-mx)&MASK;y=v[p]
   su=(su-delta)&MASK
 return v

def encode(raw):
 raw=raw+b'\0'*((-len(raw))%4)+struct.pack('<I',len(raw));v=list(struct.unpack('<%dI'%(len(raw)//4),raw));k=list(struct.unpack('<4I',key));return struct.pack('<%dI'%len(v),*cipher(v,k))
def decode(raw):
 v=list(struct.unpack('<%dI'%(len(raw)//4),raw));k=list(struct.unpack('<4I',key));b=struct.pack('<%dI'%len(v),*cipher(v,k,False));length=struct.unpack('<I',b[-4:])[0];assert len(b)-7<=length<=len(b)-4;return b[:length]
