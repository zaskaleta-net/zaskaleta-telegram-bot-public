import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePublicHousingListings } from '../src/housing-public-sources.mjs';
const criteria={location:'Kiel',rooms:'2-3',amount:1000};
const offer=(sourceId,id,extra={})=>({sourceId,id,location:'Kiel',rooms:2,price:700,priceType:'Kaltmiete',areaSqm:60,...extra});
test('cross-source merge preserves distinct city-only offers and different price measures',()=>{
 assert.equal(mergePublicHousingListings([offer('a','1'),offer('b','2')],criteria).length,2);
 const location='Teststraße 12, 24103 Kiel';
 assert.equal(mergePublicHousingListings([offer('a','1',{location}),offer('b','2',{location,priceType:'Warmmiete'})],criteria).length,2);
 assert.equal(mergePublicHousingListings([offer('a','1',{location}),offer('b','2',{location})],criteria).length,1);
 assert.equal(mergePublicHousingListings([offer('a','1'),offer('a','1')],criteria).length,1);
});
test('public feed sorts known distance then room relevance then freshness; missing distance stays unknown',()=>{
 const items=[offer('a','old',{createdAt:'2026-09-01'}),offer('b','new',{createdAt:'2026-09-10'}),offer('c','near',{distanceKm:1}),offer('d','far',{distanceKm:4}),offer('e','best',{rooms:2.5})];
 assert.deepEqual(mergePublicHousingListings(items,criteria).map(x=>x.id),['near','far','best','new','old']);
});
