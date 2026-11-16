//! The scene's layers: each with a depth (0 far … 1 near) and an opacity, and the emitters drawn in it. Layers are
//! drawn far to near (a stable order: equal depths keep the file's order). Later pieces add a transform, a parent,
//! blend modes and effect stacks per layer (the design record's data model) — here only what drawing needs.
//! Standalone: `rustc --edition 2021 --test src/graph.rs`.

#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub depth: f32,
    pub opacity: f32,
    /// Indices of the scene's emitters drawn in this layer, in file order.
    pub emitters: Vec<usize>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Graph {
    pub layers: Vec<Layer>,
    /// Layer indices far to near.
    pub order: Vec<usize>,
}

impl Graph {
    /// Layers from (depth, opacity) pairs, and each emitter's layer index (an index out of range is put in layer 0).
    pub fn new(layers: &[(f32, f32)], emitter_layers: &[usize]) -> Graph {
        let mut ls: Vec<Layer> = layers.iter().map(|&(d, o)| Layer { depth: d, opacity: o, emitters: Vec::new() }).collect();
        if ls.is_empty() {
            ls.push(Layer { depth: 0.5, opacity: 1.0, emitters: Vec::new() });
        }
        for (e, &l) in emitter_layers.iter().enumerate() {
            let l = if l < ls.len() { l } else { 0 };
            ls[l].emitters.push(e);
        }
        let mut order: Vec<usize> = (0..ls.len()).collect();
        // (Insertion sort: stable, no float total-order trouble — depths are finite, checked by the reader.)
        for i in 1..order.len() {
            let mut j = i;
            while j > 0 && ls[order[j - 1]].depth > ls[order[j]].depth {
                order.swap(j - 1, j);
                j -= 1;
            }
        }
        Graph { layers: ls, order }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn far_to_near_and_stable() {
        let g = Graph::new(&[(0.9, 1.0), (0.1, 0.5), (0.5, 1.0), (0.1, 0.7)], &[0, 1, 2, 3, 2, 99]);
        assert_eq!(g.order, vec![1, 3, 2, 0]);
        assert_eq!(g.layers[2].emitters, vec![2, 4]);
        assert_eq!(g.layers[0].emitters, vec![0, 5]);
        let empty = Graph::new(&[], &[0]);
        assert_eq!(empty.layers.len(), 1);
        assert_eq!(empty.layers[0].emitters, vec![0]);
    }
}
